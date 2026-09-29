"""テキストをベクトル(埋め込み)に変換するプロバイダ。

- HashingEmbedder: ローカル開発用。AWS不要で全配管を検証できる(字面ベースの簡易版)
- BedrockEmbedder: AWS時代の本番用。Amazon Bedrock Titan Embeddings V2(意味ベース)
- WorkersAiEmbedder: 移行後の本番用。Cloudflare Workers AI の bge-m3(意味ベース)

環境変数 EMBEDDING_PROVIDER=hashing|bedrock|workers_ai で切り替える。
Titan と bge-m3 は同じ1024次元だが別のモデルなので、ベクトル同士は比べられない。
片方で作ったベクトルの列に他方を混ぜてはいけない(列は EMBEDDING_COLUMN で分ける)。
どちらも同じ次元数・同じインターフェースなので、呼ぶ側は違いを知らなくてよい。
"""

import json
import math
import os
import zlib
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

# Workers AI の叩き方(日次枠切れの429は再試行せず日本語で止める)は回答生成と
# 同じものを使う。定義は llm.py に1つだけ置く(2箇所に書くと片方だけ直したときに、
# 埋め込みだけ英文の RateLimitError を上げるようになる)。
# llm.py は embedding.py を読まないので循環しない。import した時点では
# os.environ を読まないので、main.py の読み込み順(secrets_file が先)も崩さない
from llm import _call_workers_ai  # noqa: E402  isort:skip

DIMENSIONS = 1024  # ManualChunk.embedding の vector(1024) と一致させること

# 埋め込みを何本まで並べて投げるか。1件0.12秒のうちほとんどが応答待ちなので、
# 並べるとそのぶん短くなる(32件で実測3.2秒→0.4秒)。
# 呼び出し側は1文書ずつ順番に処理しているので、この数だけ増えても詰まらない
EMBED_WORKERS = 8


class Embedder(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...


class HashingEmbedder:
    """文字n-gramをハッシュして固定長ベクトルにする(開発用)。

    意味は理解しないが、同じ単語を含む文同士は近いベクトルになるので、
    ベクトル検索の配管テストには十分。zlib.crc32は実行のたびに
    結果が変わらない「安定した」ハッシュなのでDB保存に使える。
    """

    def __init__(self, ngram: int = 3):
        self.ngram = ngram

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(t) for t in texts]

    def _embed(self, text: str) -> list[float]:
        vec = [0.0] * DIMENSIONS
        t = text.lower()
        for i in range(max(len(t) - self.ngram + 1, 1)):
            gram = t[i : i + self.ngram].encode("utf-8")
            h = zlib.crc32(gram)
            bucket = h % DIMENSIONS
            sign = 1.0 if (h >> 16) % 2 == 0 else -1.0
            vec[bucket] += sign
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


class BedrockEmbedder:
    """Amazon Bedrock Titan Embeddings V2(本番用)"""

    def __init__(self, model_id: str, region: str):
        # bedrockを使うときだけimport(ローカル開発で必須にしない)
        from bedrock import create_bedrock_client

        self.client = create_bedrock_client(region)
        self.model_id = model_id

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        # 1件ずつ順番に呼ぶと、チャンク数に比例して待ち時間が積み上がる。
        # 中身はBedrockの応答待ちなので、まとめて投げる。
        # 並び順は入力と揃える(DBのchunk_indexと対応させるため)
        if len(texts) <= 1:
            return [self._embed(t) for t in texts]
        with ThreadPoolExecutor(max_workers=EMBED_WORKERS) as pool:
            return list(pool.map(self._embed, texts))

    def _embed(self, text: str) -> list[float]:
        body = json.dumps(
            {
                "inputText": text[:8000],
                "dimensions": DIMENSIONS,
                "normalize": True,
            }
        )
        res = self.client.invoke_model(modelId=self.model_id, body=body)
        return json.loads(res["body"].read())["embedding"]


class WorkersAiEmbedder:
    """Cloudflare Workers AI の bge-m3(移行後の本番用)。

    OpenAI互換の /v1/embeddings を openai SDK で叩く。再試行はSDKに任せず
    _call_workers_ai を通す(回答生成と同じ)。SDKは429を一律で「待てば直る」と
    扱うため、1日の無料枠を使い切った429まで投げ直したうえで英文の
    RateLimitError を上げる。取り込み中なら「英語で落ちた1本」になり、
    検索中なら main.retrieve() がそのまま500に化ける。

    守ること(ハンドブック §5.1):
    - 失敗したら例外を投げる。静かに0ベクトルを返すと壊れたことに気づけない
    - 正規化されていなければ自前で正規化する(検索は cosine 距離で比べる)
    - 次元が 1024 でなければ止める(列定義と食い違うと INSERT で落ちる前に気づく)

    入力長(512 か 60,000 トークンか)は資料が食い違っているため、
    D1 に実機で測ってから扱いを決める。ここではまだ切らない。
    """

    # 1リクエストに入れる本数。Workers AI の上限より十分小さくして、
    # 1本が長くても合計が膨らみすぎないようにする。順番は index で並べ直す
    BATCH_SIZE = 32

    def __init__(self, model: str, client=None):
        if client is None:
            client = _create_workers_ai_client()
        self.client = client
        self.model = model

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.BATCH_SIZE):
            vectors.extend(self._embed_batch(texts[start : start + self.BATCH_SIZE]))
        return vectors

    def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        res = _call_workers_ai(
            self.client.embeddings.create, model=self.model, input=batch
        )
        # 応答には入力の位置(index)が付く。並び順が保証されている前提にせず、
        # index で入力と対応させる(ズレるとDBの chunk_index と食い違う)
        by_index = {item.index: item.embedding for item in res.data}
        if len(by_index) != len(batch):
            raise RuntimeError(
                f"埋め込みの本数が合いません: 入力{len(batch)}本に対して応答{len(by_index)}本"
            )
        vectors = []
        for i in range(len(batch)):
            vec = by_index.get(i)
            if vec is None:
                raise RuntimeError(f"埋め込みの応答に index={i} がありません")
            if len(vec) != DIMENSIONS:
                raise RuntimeError(
                    f"埋め込みの次元が違います: {len(vec)} (期待 {DIMENSIONS})。"
                    "モデル指定(CF_EMBEDDING_MODEL)を確認してください"
                )
            vectors.append(_unit_vector(vec))
        return vectors


def _unit_vector(vec: list[float]) -> list[float]:
    """長さ1に正規化する。0ベクトルは壊れている印なので例外にする"""
    norm = math.sqrt(sum(v * v for v in vec))
    if norm < 1e-6:
        raise RuntimeError("埋め込みが0ベクトルでした(モデルの応答が壊れています)")
    if abs(norm - 1.0) < 1e-3:
        return [float(v) for v in vec]
    return [float(v) / norm for v in vec]


def _create_workers_ai_client():
    """openai SDK を Cloudflare の OpenAI互換エンドポイントに向ける"""
    # workers_ai を使うときだけ import(ローカル開発で必須にしない)
    from openai import OpenAI

    account_id = os.environ.get("CF_ACCOUNT_ID")
    token = os.environ.get("CF_API_TOKEN")
    if not account_id or not token:
        raise RuntimeError(
            "EMBEDDING_PROVIDER=workers_ai には CF_ACCOUNT_ID と CF_API_TOKEN が必要です"
        )
    base_url = os.environ.get(
        "CF_AI_BASE_URL",
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    )
    # 再試行はSDKに任せない(max_retries=0)。日次枠切れの429まで投げ直して
    # 時間を捨てるため。代わりに _call_workers_ai が種類を見分けて再試行する
    # (llm._create_workers_ai_client と同じ。片方だけ直すと再試行が二重になる)
    return OpenAI(base_url=base_url, api_key=token, timeout=60.0, max_retries=0)


def create_embedder() -> Embedder:
    provider = os.environ.get("EMBEDDING_PROVIDER", "hashing")
    if provider == "workers_ai":
        return WorkersAiEmbedder(
            model=os.environ.get("CF_EMBEDDING_MODEL", "@cf/baai/bge-m3"),
        )
    if provider == "bedrock":
        return BedrockEmbedder(
            model_id=os.environ.get(
                "BEDROCK_EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0"
            ),
            region=os.environ.get("AWS_REGION", "ap-northeast-1"),
        )
    return HashingEmbedder()


def to_vector_literal(embedding: list[float]) -> str:
    """pgvectorが受け取れる '[0.1,0.2,...]' 形式の文字列にする"""
    return "[" + ",".join(f"{x:.6f}" for x in embedding) + "]"
