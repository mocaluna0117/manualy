"""検索結果の融合(RRF)と、質問に添えた画像の受け渡しのテスト。

ここは壊れても例外が出ず、静かに精度だけが落ちる場所なので、
振る舞いを固定しておく。
- RRFの並びが崩れると、関係の薄い抜粋を根拠に回答するようになる
- 画像の受け渡しが切れると、画面を見せた質問に「分かりません」と答える
"""

import base64
import io
import os
import sys
from pathlib import Path
from types import SimpleNamespace

# rag/ をimportパスに入れる(テストはrag/tests配下に置く)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://dummy/dummy")

from fastapi import HTTPException  # noqa: E402
from PIL import Image  # noqa: E402

import main  # noqa: E402
import vision  # noqa: E402
from llm import (  # noqa: E402
    BedrockAnswerGenerator,
    Context,
    StubAnswerGenerator,
    WorkersAiAnswerGenerator,
)
from main import (  # noqa: E402
    MAX_QUESTION_IMAGES,
    QuestionImage,
    SearchRequest,
    decide_outcome,
    decode_images,
    extract_options,
    fuse_by_rrf,
)
from vision import WorkersAiTranscriber  # noqa: E402


def row(chunk_id: str, title: str = "手順書") -> tuple:
    """(chunk_id, manual_id, title, content, page) の形を作る"""
    return (chunk_id, f"m-{chunk_id}", title, f"{chunk_id}の本文", 1)


class TestFuseByRrf:
    def test_複数のルートに出たものが上に来る(self):
        # bはベクトルで2位・キーワードで1位。aはベクトル1位のみ
        vector = [row("a"), row("b")]
        keyword = [row("b")]
        ranked = fuse_by_rrf([vector, keyword, []])
        # a = 1/61 ≒ 0.0164、b = 1/62 + 1/61 ≒ 0.0325
        assert [r[0] for r in ranked] == ["m-b", "m-a"]

    def test_1つのルートだけなら順位はそのまま(self):
        ranked = fuse_by_rrf([[row("a"), row("b"), row("c")], [], []])
        assert [r[0] for r in ranked] == ["m-a", "m-b", "m-c"]

    def test_件数はTOP_Kで打ち切られる(self):
        from main import TOP_K

        many = [row(str(i)) for i in range(TOP_K + 5)]
        assert len(fuse_by_rrf([many, [], []])) == TOP_K

    def test_同じチャンクの内容は重複して出ない(self):
        ranked = fuse_by_rrf([[row("a")], [row("a")], [row("a")]])
        assert len(ranked) == 1

    def test_全ルートが空なら空(self):
        assert fuse_by_rrf([[], [], []]) == []

    def test_3ルートすべてに出たものが最も強い(self):
        # aは3ルートすべての3位、bは1ルートの1位
        a = [row("x"), row("y"), row("a")]
        ranked = fuse_by_rrf([a, a, a + [row("b")]])
        assert ranked[0][0] == "m-x"  # 3ルートの1位が最上位
        # aは3回足されるので、1ルートにしか出ないbより上
        order = [r[0] for r in ranked]
        assert order.index("m-a") < order.index("m-b")


class TestDecodeImages:
    def png(self) -> str:
        import base64

        return base64.b64encode(b"\x89PNG").decode()

    def test_複数枚を順番どおりに取り出す(self):
        req = SearchRequest(
            question="q",
            images=[
                QuestionImage(base64=self.png(), format="PNG"),
                QuestionImage(base64=self.png(), format="jpeg"),
            ],
        )
        assert [fmt for _, fmt in decode_images(req)] == ["png", "jpeg"]

    def test_1枚だけ渡す古い呼び方も動く(self):
        req = SearchRequest(question="q", image_base64=self.png(), image_format="webp")
        assert decode_images(req) == [(b"\x89PNG", "webp")]

    def test_上限を超えたら断る(self):
        req = SearchRequest(
            question="q",
            images=[QuestionImage(base64=self.png(), format="png")]
            * (MAX_QUESTION_IMAGES + 1),
        )
        try:
            decode_images(req)
            raise AssertionError("上限を超えたのに通ってしまった")
        except HTTPException as e:
            assert e.status_code == 400

    def test_対応していない形式は断る(self):
        req = SearchRequest(
            question="q", images=[QuestionImage(base64=self.png(), format="bmp")]
        )
        try:
            decode_images(req)
            raise AssertionError("未対応の形式が通ってしまった")
        except HTTPException as e:
            assert "未対応" in e.detail

    def test_添付なしは空(self):
        assert decode_images(SearchRequest(question="q")) == []


class TestBuildMessages:
    """画像がClaudeへ渡るところ。ここが切れると画像を見ずに回答してしまう"""

    def build(self, images):
        gen = BedrockAnswerGenerator.__new__(BedrockAnswerGenerator)
        contexts = [Context(title="手順書", content="本文")]
        return gen._build_messages("質問です", contexts, images, None)[-1]["content"]

    def test_画像なしのときは本文だけ(self):
        content = self.build(None)
        assert len(content) == 1 and "添付されています" not in content[0]["text"]

    def test_1枚のときは枚数を言わない(self):
        content = self.build([(b"a", "png")])
        assert content[0]["image"]["format"] == "png"
        assert "上の画像が添付されています" in content[-1]["text"]

    def test_複数枚は全部渡り枚数も伝わる(self):
        content = self.build([(b"a", "png"), (b"b", "jpeg"), (b"c", "webp")])
        assert [c["image"]["format"] for c in content[:3]] == ["png", "jpeg", "webp"]
        assert "上の画像3枚が添付されています" in content[-1]["text"]

    def test_履歴があっても画像は最後の質問に付く(self):
        class Hist:
            def __init__(self, role, content):
                self.role, self.content = role, content

        gen = BedrockAnswerGenerator.__new__(BedrockAnswerGenerator)
        messages = gen._build_messages(
            "質問", [Context(title="t", content="c")], [(b"a", "gif")], [Hist("user", "前の質問")]
        )
        assert len(messages) == 2
        assert "image" in messages[1]["content"][0]


class TestDecideOutcome:
    """「答えられたか」の判定。ここが崩れると利用状況の集計が信用できなくなる"""

    def test_抜粋を根拠に答えた(self):
        assert decide_outcome([], [0, 2], []) == ("answered", True)

    def test_根拠が無いと申告(self):
        assert decide_outcome([], [], []) == ("no_basis", False)

    def test_聞き返しは可否に数えない(self):
        assert decide_outcome([], None, ["A", "B"]) == ("clarify", None)
        assert decide_outcome([], [], ["A"]) == ("clarify", None)

    def test_管理操作は可否に数えない(self):
        assert decide_outcome(["create_folder"], None, []) == ("admin", None)

    def test_申告が無ければ判定漏れとして残す(self):
        assert decide_outcome([], None, []) == ("unreported", None)


class TestHideAdminOnly:
    """鍵付き(管理者だけに見せる)フォルダを、検索の3ルートすべてから外せているか。

    ここが抜けると、一覧に出していないマニュアルの中身がAIの回答として出る。
    管理者の質問でも外す(鍵付きは業務の回答に使わない資料を入れる場所で、
    根拠の枠を奪うと本来出るべきマニュアルが押し出されるため)。
    実際にSQLを組み立てて、条件が入っているかを見る。
    """

    class FakeCursor:
        """SQLを受け取って覚えておくだけの偽物(DBには繋がない)"""

        def __init__(self):
            self.queries: list[str] = []

        def execute(self, sql, params=None):
            self.queries.append(sql)

        def fetchall(self):
            return []

    def run(self) -> list[str]:
        from main import hybrid_search

        cur = self.FakeCursor()
        hybrid_search(cur, "[0,0]", ["水栓", "漏水"])
        return cur.queries

    def test_3ルートすべてに除外条件が入る(self):
        queries = self.run()
        assert len(queries) == 3, "ベクトル・キーワード・タイトルの3本が動くこと"
        for sql in queries:
            assert "admin_only" in sql

    def test_権限で除外条件を切り替える引数は残っていない(self):
        # 引数で切り替えられると「管理者だから含める」呼び出しが将来復活し、
        # 鍵付きの資料が回答の根拠に混ざる。引数を持たないことで塞ぐ
        import inspect

        from main import hybrid_search

        params = list(inspect.signature(hybrid_search).parameters)
        assert params == ["cur", "query_vec", "terms"]

    def test_検索を呼ぶ側も権限を渡していない(self):
        # retrieve()と下書き生成の両方が、引数なしで呼んでいること
        import re

        source = (Path(__file__).resolve().parents[1] / "main.py").read_text(
            encoding="utf-8"
        )
        # 定義そのもの(def hybrid_search(...))は除いて、呼び出しだけを見る
        calls = re.findall(r"(?<!def )hybrid_search\(cur[^)]*\)", source)
        assert calls, "呼び出しが見つからない(名前を変えたらこのテストも直す)"
        for call in calls:
            assert call == "hybrid_search(cur, query_vec, terms)", call

    def test_除外条件は未分類を巻き込まない(self):
        # NOT EXISTS(...)なので、categoryIdがnullの行は残る
        sql = self.run()[0]
        assert "NOT EXISTS" in sql and '"ManualCategory"' in sql

    def test_取り込み済み・ゴミ箱以外という条件は残っている(self):
        for sql in self.run():
            assert "ingest_status = 'COMPLETED'" in sql
            assert "deleted_at IS NULL" in sql


class TestAdminTools:
    """チャットからの管理操作。フォルダを鍵付きで作れること"""

    def tool(self, name: str) -> dict:
        from llm import ADMIN_TOOLS

        for t in ADMIN_TOOLS:
            if t["toolSpec"]["name"] == name:
                return t["toolSpec"]
        raise AssertionError(f"{name} が見つかりません")

    def test_フォルダ作成に鍵付きの指定がある(self):
        props = self.tool("create_folder")["inputSchema"]["json"]["properties"]
        assert "admin_only" in props
        assert props["admin_only"]["type"] == "boolean"

    def test_鍵付きは必須ではない(self):
        # 指定が無ければ全員に見えるフォルダになる(既定は開いている側ではなく
        # 「これまで通り」。隠す意図があるときだけ明示させる)
        required = self.tool("create_folder")["inputSchema"]["json"]["required"]
        assert required == ["name"]

    def test_言い回しの手がかりが説明に入っている(self):
        desc = self.tool("create_folder")["inputSchema"]["json"]["properties"][
            "admin_only"
        ]["description"]
        for word in ["鍵付き", "管理者だけ"]:
            assert word in desc

    def test_システムプロンプトが他の保管場所と取り違えないよう釘を刺している(self):
        from llm import ADMIN_SYSTEM_ADDENDUM

        assert "admin_only" in ADMIN_SYSTEM_ADDENDUM
        assert "鍵付き" in ADMIN_SYSTEM_ADDENDUM


class TestFolderTools:
    """フォルダの変更・削除。作り直しや「機能が無い」で断られないこと"""

    def tool(self, name: str) -> dict:
        from llm import ADMIN_TOOLS

        for t in ADMIN_TOOLS:
            if t["toolSpec"]["name"] == name:
                return t["toolSpec"]
        raise AssertionError(f"{name} が見つかりません")

    def test_変更のツールは対象だけが必須(self):
        # 名前だけ・鍵だけ・両方、のどれでも呼べるようにする。
        # new_nameを必須にすると「鍵付きにして」だけの依頼で呼べなくなる
        schema = self.tool("update_folder")["inputSchema"]["json"]
        assert schema["required"] == ["folder"]
        props = schema["properties"]
        assert "new_name" in props and props["admin_only"]["type"] == "boolean"

    def test_削除のツールがある(self):
        schema = self.tool("delete_folder")["inputSchema"]["json"]
        assert schema["required"] == ["folder"]

    def test_できないと答えないよう指示文で釘を刺している(self):
        from llm import ADMIN_SYSTEM_ADDENDUM

        assert "「その機能はありません」と答えてはいけない" in ADMIN_SYSTEM_ADDENDUM
        assert "create_folderで作り直してはいけない" in ADMIN_SYSTEM_ADDENDUM
        # 鍵付きへの変更と削除の呼び方も書いてある
        assert "update_folder" in ADMIN_SYSTEM_ADDENDUM
        assert "delete_folder" in ADMIN_SYSTEM_ADDENDUM


class TestDraftManual:
    """答えられなかった質問からの下書き。

    ここで一番怖いのは、分からないことをもっともらしく埋めてしまうこと。
    推測で書かれた手順がマニュアルになると「書いてあるから」と実行される。
    プロンプトがそれを禁じていることを固定しておく。
    """

    def prompt_of(self, question: str, contexts) -> str:
        """実際に組み立てられるプロンプトを、AWSを呼ばずに取り出す"""
        from llm import BedrockAnswerGenerator

        gen = BedrockAnswerGenerator.__new__(BedrockAnswerGenerator)
        captured = {}

        class FakeClient:
            def converse(self, **kwargs):
                captured["prompt"] = kwargs["messages"][0]["content"][0]["text"]
                captured["config"] = kwargs["inferenceConfig"]
                return {"output": {"message": {"content": [{"text": "# 下書き"}]}}}

        gen.client = FakeClient()
        gen.model_id = "dummy"
        gen.draft_manual(question, contexts)
        return captured["prompt"]

    def test_質問と抜粋の両方が渡る(self):
        from llm import Context

        prompt = self.prompt_of(
            "トイレの漏水はどうする？", [Context(title="漏水対応", content="止水栓を閉める")]
        )
        assert "トイレの漏水はどうする？" in prompt
        assert "止水栓を閉める" in prompt and "漏水対応" in prompt

    def test_でっち上げを禁じている(self):
        prompt = self.prompt_of("q", [])
        assert "抜粋に無い手順・数値・連絡先・期限は絶対に書かない" in prompt
        assert "(要確認:" in prompt

    def test_関連資料が無くても組み立てられる(self):
        prompt = self.prompt_of("q", [])
        assert "関連する既存マニュアルは見つかりませんでした" in prompt

    def test_事実を作らせないよう温度は0(self):
        from llm import BedrockAnswerGenerator

        gen = BedrockAnswerGenerator.__new__(BedrockAnswerGenerator)
        captured = {}

        class FakeClient:
            def converse(self, **kwargs):
                captured.update(kwargs["inferenceConfig"])
                return {"output": {"message": {"content": [{"text": "x"}]}}}

        gen.client = FakeClient()
        gen.model_id = "dummy"
        gen.draft_manual("q", [])
        assert captured["temperature"] == 0

    def test_構成の指示が入っている(self):
        prompt = self.prompt_of("q", [])
        for section in ["目的", "対象となる場面", "手順", "注意点", "関連資料"]:
            assert section in prompt


class TestExtractOptions:
    """選択肢のボタン化。

    1つのボタンに2案が入ってしまうと、利用者はどちらも選べず先へ進めない。
    実際に「工事種別ごとに…したい / 施工説明書を…まとめたい」が1個の
    ボタンになり選べなかった、という報告があったので、その形を固定する。
    """

    def test_1行に1つならそのまま(self):
        body, options = extract_options(
            "どちらにしますか?\n[選択肢] まとめる\n[選択肢] 分ける"
        )
        assert options == ["まとめる", "分ける"]
        assert "[選択肢]" not in body

    def test_1行に2案が入っていたら分ける(self):
        _, options = extract_options(
            "どちらのご希望ですか?\n"
            "[選択肢] 工事種別ごとにフォルダ名で区別したい / "
            "施工説明書を1つのフォルダにまとめたい"
        )
        assert options == [
            "工事種別ごとにフォルダ名で区別したい",
            "施工説明書を1つのフォルダにまとめたい",
        ]

    def test_全角スラッシュでも分ける(self):
        _, options = extract_options("[選択肢] Aにする ／ Bにする")
        assert options == ["Aにする", "Bにする"]

    def test_3案でも分ける(self):
        _, options = extract_options("[選択肢] A案 / B案 / C案")
        assert options == ["A案", "B案", "C案"]

    def test_語の中のスラッシュは割らない(self):
        # 「A/B工法」のように空白の無いスラッシュは1つの選択肢のまま
        _, options = extract_options("[選択肢] A/B工法の違いを知りたい")
        assert options == ["A/B工法の違いを知りたい"]

    def test_割ると欠片になる場合は元のまま(self):
        _, options = extract_options("[選択肢] は / を")
        assert options == ["は / を"]

    def test_選択肢が無ければ空(self):
        body, options = extract_options("ここに手順があります。")
        assert options == []
        assert body == "ここに手順があります。"


class TestEmbedParallel:
    """埋め込みを並べて投げても、並び順が入れ替わらないこと。

    順番が狂うと、チャンクの本文と別のベクトルが結びつく。
    検索は静かにおかしくなるだけで例外も出ないので、ここで止める。
    """

    class FakeBedrock:
        """呼ばれた順ではなく、渡された文字列に対応する値を返す偽物"""

        def invoke_model(self, modelId, body):  # noqa: N803
            import json as _json
            import time as _time
            from io import BytesIO

            text = _json.loads(body)["inputText"]
            # 後の要素ほど速く返すようにして、順序が崩れやすい状況を作る
            _time.sleep(0.02 / (int(text) + 1))
            vec = [float(int(text))] * 4
            return {"body": BytesIO(_json.dumps({"embedding": vec}).encode())}

    def _embedder(self):
        from embedding import BedrockEmbedder

        e = BedrockEmbedder.__new__(BedrockEmbedder)
        e.client = self.FakeBedrock()
        e.model_id = "dummy"
        return e

    def test_並べて投げても入力の順番どおりに返る(self):
        e = self._embedder()
        texts = [str(i) for i in range(20)]
        got = e.embed_texts(texts)
        assert [v[0] for v in got] == [float(i) for i in range(20)]

    def test_1件のときも同じ結果になる(self):
        e = self._embedder()
        assert e.embed_texts(["7"]) == [[7.0] * 4]

    def test_空のときは空を返す(self):
        assert self._embedder().embed_texts([]) == []


class FakeChatCompletions:
    """Workers AI(OpenAI互換)の chat.completions の偽物"""

    def __init__(self, text: str):
        self.text = text
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=self.text))]
        )


def fake_ai_client(text: str):
    return SimpleNamespace(chat=SimpleNamespace(completions=FakeChatCompletions(text)))


class FakeCursor:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return FakeCursor()


RETRIEVED_ROW = ("m-1", "手順書", "本文", 1)


def stub_db(monkeypatch, rows=(RETRIEVED_ROW,)):
    """retrieve() のDB部分だけを外す(検索SQLはここの検証対象ではない)"""
    monkeypatch.setattr(main, "db_connect", lambda: FakeConn())
    monkeypatch.setattr(main, "hybrid_search", lambda cur, vec, terms: list(rows))
    monkeypatch.setattr(
        main, "embedder", SimpleNamespace(embed_texts=lambda texts: [[0.1] * 1024])
    )


def noisy_jpeg(width: int, height: int) -> bytes:
    """圧縮の効かない写真(スマホ写真の最悪ケース)"""
    image = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def request_with(image_bytes: bytes) -> SearchRequest:
    return SearchRequest(
        question="この画面はどうすればいい?",
        images=[
            QuestionImage(
                base64=base64.b64encode(image_bytes).decode("ascii"), format="jpeg"
            )
        ],
    )


class TestRetrieveDescribeFailure:
    """describe() の失敗で、画像を添えた質問がまるごと500にならないこと。

    WorkersAiTranscriber.describe は自分で空文字に倒すが、切り替え日まで
    本番の BedrockTranscriber.describe は AWS の4xx/5xxをそのまま上げる。
    retrieve() が受けていないと、その例外が /search を500にする。
    説明文は検索語を増やすための味付けなので、無ければ質問文だけで続ければよい。
    """

    def _generator(self):
        return SimpleNamespace(
            rewrite_query=lambda q, h: q,
            prepare_images=lambda images: images,
        )

    def test_describeが例外でも検索は続く(self, monkeypatch):
        stub_db(monkeypatch)
        monkeypatch.setattr(main, "answer_generator", self._generator())

        def boom(images):
            raise RuntimeError("An error occurred (ThrottlingException)")

        monkeypatch.setattr(main, "transcriber", SimpleNamespace(describe=boom))
        rows, images = main.retrieve(request_with(noisy_jpeg(40, 30)))
        assert rows == [RETRIEVED_ROW]
        assert len(images) == 1  # 画像そのものは回答生成へ渡し続ける

    def test_説明文が取れたときは検索語に足す(self, monkeypatch):
        # 上のテストが「常に握りつぶす」だけで通らないようにする対の確認
        stub_db(monkeypatch)
        monkeypatch.setattr(main, "answer_generator", self._generator())
        monkeypatch.setattr(
            main, "transcriber", SimpleNamespace(describe=lambda images: "在庫照会画面")
        )
        seen: list[str] = []
        monkeypatch.setattr(
            main,
            "embedder",
            SimpleNamespace(
                embed_texts=lambda texts: seen.append(texts[0]) or [[0.1] * 1024]
            ),
        )
        main.retrieve(request_with(noisy_jpeg(40, 30)))
        assert "在庫照会画面" in seen[0]


class TestRetrieveShrinksOnce:
    """添付画像の縮小が2回走らないこと。

    以前は retrieve() が describe 用に縮め、そのあと _build_messages が
    元の画像からもう一度縮めていた(実写4枚で0.59秒×2)。
    0.5vCPU の Cloud Run では effective に効いてくる。
    retrieve() が縮小後の画像を返し、search()/search_stream() が
    それを generate に渡すことで1回に収める。
    """

    def _count_shrinks(self, monkeypatch) -> list[int]:
        """実際に焼き直した回数だけを数える(素通しは数えない)"""
        done: list[int] = []
        real = vision._shrink_one

        def wrapped(image_bytes, image_format):
            out = real(image_bytes, image_format)
            if out[0] is not image_bytes:
                done.append(len(image_bytes))
            return out

        monkeypatch.setattr(vision, "_shrink_one", wrapped)
        return done

    def _wire(self, monkeypatch):
        stub_db(monkeypatch)
        generator = WorkersAiAnswerGenerator(model="m", client=fake_ai_client("キーワード"))
        monkeypatch.setattr(main, "answer_generator", generator)
        monkeypatch.setattr(
            main,
            "transcriber",
            WorkersAiTranscriber(model="m", client=fake_ai_client("説明文")),
        )
        return generator

    def test_説明用と回答用で縮小は1回きり(self, monkeypatch):
        generator = self._wire(monkeypatch)
        shrinks = self._count_shrinks(monkeypatch)
        raw = noisy_jpeg(2400, 1800)
        assert len(raw) > vision.SHRINK_SKIP_BYTES

        rows, images = main.retrieve(request_with(raw))
        # search()/search_stream() はこの images をそのまま generate に渡す
        generator._build_messages("q", [Context(title="t", content="c")], images, None, False)

        assert len(shrinks) == 1, f"縮小が{len(shrinks)}回走った"

    def test_縮めた画像を返す(self, monkeypatch):
        self._wire(monkeypatch)
        raw = noisy_jpeg(2400, 1800)
        rows, images = main.retrieve(request_with(raw))
        assert len(images[0][0]) < len(raw)
        assert max(Image.open(io.BytesIO(images[0][0])).size) == vision.MAX_IMAGE_EDGE


class TestPrepareImagesEverywhere:
    """main.retrieve() が呼ぶ prepare_images は、どの提供元にも要る。

    1つでも欠けると、画像を添えた質問が AttributeError で500になる。
    Protocol に書いてあっても ragにはmypyもCIも無く、型検査では落ちない。
    """

    def test_3提供元すべてが持っている(self):
        for cls in (StubAnswerGenerator, BedrockAnswerGenerator, WorkersAiAnswerGenerator):
            assert callable(getattr(cls, "prepare_images", None)), cls.__name__

    def test_Bedrockは今までどおり素通しする(self):
        # 切り替え日まで本番。ここで縮めると写真の細かい文字の読み取りが変わる
        g = BedrockAnswerGenerator.__new__(BedrockAnswerGenerator)
        images = [(b"raw", "jpeg")]
        assert g.prepare_images(images) == images
