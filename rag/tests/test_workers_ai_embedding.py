"""Workers AI(bge-m3)の埋め込みプロバイダのテスト。

ここは壊れても例外が出ず、静かに検索精度だけが落ちる場所なので、
「壊れたら止まる」ことを固定する。
- 順番がズレると、DBの chunk_index と本文が食い違い、別のページを根拠に答える
- 0ベクトルや次元違いを黙って通すと、そのチャンクだけ永久に検索に出なくなる
- 日次枠切れの429をSDK任せで再試行すると、回復しない429を投げ直したうえで
  英文の RateLimitError が上がる。検索中なら main.retrieve() がそのまま500に化ける
"""

import math
import os
import sys
from types import SimpleNamespace

import pytest
from openai import APIConnectionError, RateLimitError

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import embedding  # noqa: E402
from embedding import DIMENSIONS, WorkersAiEmbedder, create_embedder  # noqa: E402


def unit(i: int) -> list[float]:
    """i 番目だけ 1 の単位ベクトル"""
    vec = [0.0] * DIMENSIONS
    vec[i % DIMENSIONS] = 1.0
    return vec


class FakeEmbeddings:
    """openai SDK の client.embeddings を真似る。応答は make(batch) で作る"""

    def __init__(self, make):
        self.make = make
        self.calls: list[list[str]] = []

    def create(self, model: str, input: list[str]):
        self.calls.append(list(input))
        return SimpleNamespace(data=self.make(input))


def fake_client(make):
    return SimpleNamespace(embeddings=FakeEmbeddings(make))


def item(index: int, embedding: list[float]):
    return SimpleNamespace(index=index, embedding=embedding)


class TestWorkersAiEmbedder:
    def test_入力の順番どおりに返す(self):
        # 応答は index 付きだが、あえて逆順で返す(並び順の保証を前提にしない)
        client = fake_client(
            lambda batch: [item(i, unit(i)) for i in reversed(range(len(batch)))]
        )
        emb = WorkersAiEmbedder(model="m", client=client)
        out = emb.embed_texts(["a", "b", "c"])
        assert [v.index(1.0) for v in out] == [0, 1, 2]

    def test_32本ずつに分けて投げる(self):
        client = fake_client(lambda batch: [item(i, unit(i)) for i in range(len(batch))])
        emb = WorkersAiEmbedder(model="m", client=client)
        out = emb.embed_texts([f"t{i}" for i in range(70)])
        assert len(out) == 70
        assert [len(c) for c in client.embeddings.calls] == [32, 32, 6]

    def test_空なら呼ばない(self):
        client = fake_client(lambda batch: [])
        emb = WorkersAiEmbedder(model="m", client=client)
        assert emb.embed_texts([]) == []
        assert client.embeddings.calls == []

    def test_正規化されていなければ長さ1にする(self):
        client = fake_client(lambda batch: [item(0, [3.0] + [4.0] + [0.0] * (DIMENSIONS - 2))])
        emb = WorkersAiEmbedder(model="m", client=client)
        (vec,) = emb.embed_texts(["a"])
        assert math.isclose(math.sqrt(sum(v * v for v in vec)), 1.0, abs_tol=1e-9)
        assert math.isclose(vec[0], 0.6) and math.isclose(vec[1], 0.8)

    def test_0ベクトルは例外にする(self):
        # 黙って0ベクトルを保存すると、そのチャンクだけ永久に検索に出なくなる
        client = fake_client(lambda batch: [item(0, [0.0] * DIMENSIONS)])
        emb = WorkersAiEmbedder(model="m", client=client)
        with pytest.raises(RuntimeError, match="0ベクトル"):
            emb.embed_texts(["a"])

    def test_次元が違えば例外にする(self):
        client = fake_client(lambda batch: [item(0, [1.0] * 768)])
        emb = WorkersAiEmbedder(model="m", client=client)
        with pytest.raises(RuntimeError, match="次元"):
            emb.embed_texts(["a"])

    def test_本数が足りなければ例外にする(self):
        client = fake_client(lambda batch: [item(0, unit(0))])
        emb = WorkersAiEmbedder(model="m", client=client)
        with pytest.raises(RuntimeError, match="本数"):
            emb.embed_texts(["a", "b"])


class RaisingEmbeddings:
    """先頭から順に errors を投げ、尽きたら正しい応答を返す"""

    def __init__(self, errors):
        self.errors = list(errors)
        self.calls = 0

    def create(self, model: str, input: list[str]):
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return SimpleNamespace(data=[item(i, unit(i)) for i in range(len(input))])


def api_error(cls, status: int, body=None):
    """openai SDK が投げてくるHTTPエラーを組み立てる(llm側のテストと同じ形)"""
    response = SimpleNamespace(status_code=status, headers={}, request=None)
    message = f"Error code: {status}" if body is None else f"Error code: {status} - {body}"
    return cls(message, response=response, body=body)


# 実機の生ダンプ。Cloudflare は OpenAI 形式ではなく errors[] で code を返す
DAILY_QUOTA_BODY = {
    "errors": [
        {
            "message": (
                "AiError: AiError: you have used up your daily free allocation of "
                "10,000 neurons, please upgrade to Cloudflare's Workers Paid plan "
                "if you would like to continue usage. (378e2df2-253d)"
            ),
            "code": 4006,
        }
    ],
    "success": False,
}


def raising_embedder(errors):
    emb = RaisingEmbeddings(errors)
    return WorkersAiEmbedder(model="m", client=SimpleNamespace(embeddings=emb)), emb


class TestDailyQuota:
    """回答生成と同じ扱いを埋め込みにも通す。

    ここが素通しだと、枠切れのときに main.retrieve() が
    英文の RateLimitError のまま HTTP 500 になる(日本語の案内が出ない)。
    """

    def test_日次枠の429は再試行せず日本語で止める(self):
        emb, calls = raising_embedder([api_error(RateLimitError, 429, DAILY_QUOTA_BODY)])
        with pytest.raises(RuntimeError, match="AIの無料枠を使い切りました"):
            emb.embed_texts(["床鳴りの対応"])
        # しばらく直らないものを投げ直さない
        assert calls.calls == 1

    def test_一時的な429は今までどおり再試行する(self, monkeypatch):
        monkeypatch.setattr("llm.time.sleep", lambda s: None)
        throttled = {"errors": [{"message": "too many requests", "code": 3000}]}
        emb, calls = raising_embedder([api_error(RateLimitError, 429, throttled)] * 2)
        assert len(emb.embed_texts(["a"])) == 1
        assert calls.calls == 3

    def test_接続断も再試行する(self, monkeypatch):
        monkeypatch.setattr("llm.time.sleep", lambda s: None)
        error = APIConnectionError(request=None)
        emb, calls = raising_embedder([error])
        assert len(emb.embed_texts(["a"])) == 1
        assert calls.calls == 2

    def test_SDK側の再試行は使わない(self, monkeypatch):
        # 二重に再試行しないこと。SDKは429を一律で「待てば直る」と扱うので、
        # 日次枠切れまで投げ直して時間を捨てる
        monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
        monkeypatch.setenv("CF_API_TOKEN", "tok")
        assert embedding._create_workers_ai_client().max_retries == 0


class TestCreateEmbedder:
    def test_workers_ai_には鍵が要る(self, monkeypatch):
        monkeypatch.setenv("EMBEDDING_PROVIDER", "workers_ai")
        monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
        monkeypatch.delenv("CF_API_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match="CF_ACCOUNT_ID"):
            create_embedder()

    def test_workers_ai_を選べる(self, monkeypatch):
        monkeypatch.setenv("EMBEDDING_PROVIDER", "workers_ai")
        monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
        monkeypatch.setenv("CF_API_TOKEN", "tok")
        emb = create_embedder()
        assert isinstance(emb, WorkersAiEmbedder)
        assert emb.model == "@cf/baai/bge-m3"
        # openai SDK が Cloudflare のエンドポイントに向いている
        assert "acct/ai/v1" in str(emb.client.base_url)
