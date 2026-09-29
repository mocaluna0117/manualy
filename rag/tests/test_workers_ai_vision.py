"""Workers AI(gemma)の画像書き起こしプロバイダのテスト。

ここは1ページの失敗をmain.pyが握りつぶす作りなので、黙って壊れやすい。
- 空文字を返すと「書き起こせたが中身が無いページ」として素通しされ、検索から消える
- 失敗の実際の形は空文字ではなく断り文。通すと断り文がページ本文として検索に載る
- 逐語の補足を落とすと、モデルが足した前置きや感想がそのまま検索対象の本文になる
- 思考を切り忘れると、書き起こしがまるごと独り言に置き換わる
- describe が例外を投げると、画像を添えた質問がまるごと HTTP 500 になる
  (main.py:742 の retrieve() が受けていない)
- 断り文の判定(_looks_like_refusal)は Bedrock 版とも共有しているので、
  切り替え日まで本番の BedrockTranscriber 側もここで一緒に固定する
- 添付画像を縮めずに投げると、スマホ写真2枚でボディ上限を超えて400になる
"""

import base64
import io
import os
import sys
from types import SimpleNamespace

import pytest
from openai import BadRequestError, RateLimitError
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vision import (  # noqa: E402
    DESCRIBE_PROMPT,
    BedrockTranscriber,
    MAX_IMAGE_EDGE,
    REFUSAL_MAX_CHARS,
    SHRINK_DONE_BYTES,
    SHRINK_SKIP_BYTES,
    TRANSCRIBE_PROMPT,
    VERBATIM_ADDENDUM,
    WorkersAiTranscriber,
    create_transcriber,
    shrink_for_upload,
)


class FakeCompletions:
    def __init__(self, text="書き起こし結果"):
        self.text = text
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=self.text))]
        )


def transcriber(text="書き起こし結果", model="m"):
    client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions(text)))
    return WorkersAiTranscriber(model=model, client=client)


class RaisingCompletions:
    """必ず失敗する client.chat.completions(APIエラーの再現用)"""

    def __init__(self, error):
        self.error = error
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        raise self.error


def raising_transcriber(error, model="m"):
    client = SimpleNamespace(chat=SimpleNamespace(completions=RaisingCompletions(error)))
    return WorkersAiTranscriber(model=model, client=client)


def api_error(cls, status: int, body=None):
    """openai SDK が投げてくるHTTPエラーを組み立てる(実物と同じ文面にする)"""
    response = SimpleNamespace(status_code=status, headers={}, request=None)
    message = f"Error code: {status}" if body is None else f"Error code: {status} - {body}"
    return cls(message, response=response, body=body)


# 実機の生ダンプ(1日の無料枠を使い切った429)
DAILY_QUOTA_BODY = {
    "errors": [
        {
            "message": (
                "AiError: AiError: you have used up your daily free allocation of "
                "10,000 neurons, please upgrade to Cloudflare's Workers Paid plan"
            ),
            "code": 4006,
        }
    ],
    "success": False,
}

# 実測の断り文(真っ白な200x200のJPEGを transcribe に投げた結果)
BLANK_PAGE_REFUSAL = (
    "申し訳ありませんが、提供された画像は真っ白な空白の画像であり、"
    "テキスト、図、または表が含まれていません。"
    "そのため、書き起こしを行うことができません。"
)


def noisy_jpeg(width: int, height: int) -> bytes:
    """圧縮の効かない写真(スマホ写真の最悪ケース)"""
    image = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


class FakeConverse:
    """BedrockTranscriber が叩く converse の偽物(boto3を使わずに組み立てる)"""

    def __init__(self, text):
        self.text = text
        self.calls: list[dict] = []

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        return {"output": {"message": {"content": [{"text": self.text}]}}}


def bedrock_transcriber(text):
    # __init__ は boto3 クライアントを作りに行くので通さない
    t = BedrockTranscriber.__new__(BedrockTranscriber)
    t.client = FakeConverse(text)
    t.model_id = "m"
    return t


def sent_content(t) -> list[dict]:
    return t.client.chat.completions.calls[0]["messages"][0]["content"]


class TestWorkersAiTranscriber:
    def test_enabledがTrue(self):
        # main.py:498 がこの属性で取り込み時の書き起こしを分岐する
        assert WorkersAiTranscriber.enabled is True

    def test_画像をdataURIで渡す(self):
        t = transcriber()
        t.transcribe(b"\xff\xd8\xff")
        content = sent_content(t)
        expected = base64.b64encode(b"\xff\xd8\xff").decode("ascii")
        assert content[0]["type"] == "image_url"
        assert content[0]["image_url"]["url"] == f"data:image/jpeg;base64,{expected}"

    @pytest.mark.parametrize("image_format", ["png", "jpeg", "webp", "gif"])
    def test_ALLOWED_IMAGE_FORMATSの4形式を組める(self, image_format):
        # main.py の ALLOWED_IMAGE_FORMATS と揃っていること
        t = transcriber()
        t.describe([(b"data", image_format)])
        url = sent_content(t)[0]["image_url"]["url"]
        assert url.startswith(f"data:image/{image_format};base64,")

    def test_逐語出力の補足を足す(self):
        # 素のプロンプトだけだと前置き・見出し・感想まで書き起こしに混ざる
        t = transcriber()
        t.transcribe(b"img")
        prompt = sent_content(t)[-1]["text"]
        assert prompt.startswith(TRANSCRIBE_PROMPT)
        assert prompt.endswith(VERBATIM_ADDENDUM)
        assert "前置き" in prompt

    def test_共有のTRANSCRIBE_PROMPTを書き換えない(self):
        # 定数を直すとBedrock版(切り替え日まで本番)の挙動まで変わる
        transcriber().transcribe(b"img")
        assert "前置き" not in TRANSCRIBE_PROMPT

    def test_describeは補足を足さない(self):
        t = transcriber()
        t.describe([(b"img", "png")])
        assert sent_content(t)[-1]["text"] == DESCRIBE_PROMPT

    def test_画像0枚ならAPIを呼ばない(self):
        # Bedrock版と同じ。呼ぶだけ無駄でニューロンも減る
        t = transcriber()
        assert t.describe([]) == ""
        assert t.client.chat.completions.calls == []

    def test_複数枚を1リクエストにまとめる(self):
        t = transcriber()
        t.describe([(b"a", "png"), (b"b", "jpeg")])
        content = sent_content(t)
        assert len(t.client.chat.completions.calls) == 1
        # 画像が先、プロンプトが最後
        assert [c["type"] for c in content] == ["image_url", "image_url", "text"]

    def test_思考を切るフラグを送る(self):
        t = transcriber()
        t.transcribe(b"img")
        t.describe([(b"img", "png")])
        for call in t.client.chat.completions.calls:
            assert call["extra_body"] == {
                "chat_template_kwargs": {"enable_thinking": False}
            }

    def test_空の書き起こしは例外にする(self):
        # 空文字を返すとmain.pyが「中身の無いページ」として素通しし、失敗に気づけない
        with pytest.raises(RuntimeError, match="空でした"):
            transcriber(text="   ").transcribe(b"img")

    def test_contentがNoneでも落ちない(self):
        with pytest.raises(RuntimeError, match="空でした"):
            transcriber(text=None).transcribe(b"img")

    def test_max_tokensはBedrock版に揃える(self):
        t = transcriber()
        t.transcribe(b"img")
        t.describe([(b"img", "png")])
        assert [c["max_tokens"] for c in t.client.chat.completions.calls] == [2048, 512]


class TestRefusal:
    """失敗の実際の形は空文字ではなく断り文。これを本文として通さない"""

    def test_文字が無ければ何も出力しないと指示する(self):
        # 断り文を書かせないための予防。後段の判定と両方要る
        # (プロンプトだけでは実測で断り文が消えなかった)
        assert "何も出力しないでください" in VERBATIM_ADDENDUM
        assert "何も出力しないでください" not in TRANSCRIBE_PROMPT  # Bedrock版は据え置き

    def test_断り文は書き起こしとして通さない(self):
        # main.py:503 は文字の取れないページ(白紙・区切り)を書き起こしに回すので、
        # 通すとこの断り文がpages[index]を上書きし、マニュアル本文として検索に載る。
        # 例外にすれば main.py:509 が握りつぶし、そのページは元のまま素通しになる
        with pytest.raises(RuntimeError, match="断り文"):
            transcriber(text=BLANK_PAGE_REFUSAL).transcribe(b"img")

    def test_describeの断り文は検索語に足さない(self):
        # 実測で『画像が添付されていないようです。…』が返る。
        # そのまま足すと、まるで関係の無い語で検索することになる
        t = transcriber(text="画像が添付されていないようです。もう一度お試しください。")
        assert t.describe([(b"img", "png")]) == ""

    def test_実在するページ本文を断り文と間違えない(self):
        # 書き起こしに回るのは文字がほとんど無いページなので、著作権表記や
        # 区切りページが現実に当たる。『できません』『ありません』を
        # マーカーに入れていたときは、この2文がどちらも断り文と判定され、
        # 本物のページ本文が例外で捨てられていた(実測で確認)
        for page in (
            "画像の無断転載はできません。",
            "この画像に該当する手順はありません。次ページへ進んでください。",
        ):
            assert transcriber(text=page).transcribe(b"img") == page

    def test_実測の断り文2種は今までどおり捕まえる(self):
        # マーカーを絞っても、実際に観測された断り方は両方とも落ちること
        with pytest.raises(RuntimeError, match="断り文"):
            transcriber(text=BLANK_PAGE_REFUSAL).transcribe(b"img")
        assert (
            transcriber(
                text="画像が添付されていないようです。もう一度お試しください。"
            ).describe([(b"img", "png")])
            == ""
        )

    def test_150文字を超える断り文も捕まえる(self):
        # 本番データの写しで、150文字以下の断り文の最長は145文字だった。
        # 上限が150のままだと余裕が5文字しかなく、少し丁寧に断られると素通しする
        wordy = (
            "申し訳ございません。ご提示いただいた画像を確認いたしましたが、"
            "解像度が低いためか文字らしきものを判別することができず、"
            "書き起こしの対象となるテキストが含まれていません。"
            "図や表についても輪郭が不明瞭で、内容を説明できる状態にありません。"
            "お手数ですが、より鮮明な画像をご用意のうえ、"
            "もう一度お試しいただけますでしょうか。"
        )
        assert 150 < len(wordy) <= REFUSAL_MAX_CHARS
        with pytest.raises(RuntimeError, match="断り文"):
            transcriber(text=wordy).transcribe(b"img")

    def test_断り文の語が入っていても長い本文は通す(self):
        # 「〜はできません」と書かれた本物のページを捨てないこと
        page = "この操作は管理者以外にはできません。" * 20
        assert transcriber(text=page).transcribe(b"img") == page

    def test_断り文に見えない短い本文は通す(self):
        page = "第3章 漏水対応\n1. 止水栓を閉める"
        assert transcriber(text=page).transcribe(b"img") == page


class TestBedrockRefusal:
    """切り替え日まで本番の Bedrock 版も、断り文をページ本文にしない。

    本番データの写し(ManualChunk 4424件)に残っている断り文4件は、
    判定を通していなかったこの経路で入ったもの。切り替え後に再取り込みしても、
    ここが素通しのままだと同じ汚染がまた作られる。
    """

    def test_断り文はページ本文にしない(self):
        with pytest.raises(RuntimeError, match="断り文"):
            bedrock_transcriber(BLANK_PAGE_REFUSAL).transcribe(b"img")

    def test_実在するページ本文はそのまま返す(self):
        # Workers AI 版と同じ判定を使うので、著作権表記・区切りページは通る
        for page in (
            "画像の無断転載はできません。",
            "この画像に該当する手順はありません。次ページへ進んでください。",
        ):
            assert bedrock_transcriber(page).transcribe(b"img") == page

    def test_共有のプロンプトと最大トークンは変えない(self):
        # 判定を足しただけで、AWS版の投げ方そのものは今までどおりであること
        t = bedrock_transcriber("本文")
        t.transcribe(b"img")
        sent = t.client.calls[0]
        assert sent["messages"][0]["content"][-1]["text"] == TRANSCRIBE_PROMPT
        assert sent["inferenceConfig"]["maxTokens"] == 2048


class TestDescribeNeverRaises:
    """describe が例外を投げると、画像を添えた質問がまるごと HTTP 500 になる。

    呼び出し元(main.py:742 retrieve())は describe を素で呼んでいて、
    /search も retrieve() を素で呼ぶ(main.py:773)。説明文は検索語を
    増やすための味付けなので、失敗したら空文字で検索を続ければよい。
    """

    def test_APIが400でも空文字を返す(self):
        # 実測: 9x9のPNGを1枚添付して /search → 500
        # (Workers AI は10px未満の画像を400で拒否する)
        error = api_error(
            BadRequestError, 400, {"errors": [{"message": "image is too small"}]}
        )
        t = raising_transcriber(error)
        assert t.describe([(b"\x89PNG", "png")]) == ""

    def test_応答が空でも例外にしない(self):
        assert transcriber(text="").describe([(b"img", "png")]) == ""
        assert transcriber(text=None).describe([(b"img", "png")]) == ""

    def test_日次枠の429でも検索は続く(self):
        t = raising_transcriber(api_error(RateLimitError, 429, DAILY_QUOTA_BODY))
        assert t.describe([(b"img", "png")]) == ""
        # 回復しない429を投げ直さない(1ページごとに数秒捨てることになる)
        assert len(t.client.chat.completions.calls) == 1

    def test_書き起こし側は今までどおり例外にする(self):
        # 握りつぶすのは describe だけ。transcribe まで空を返すと、
        # 書き起こせなかったページに気づけなくなる
        t = raising_transcriber(api_error(RateLimitError, 429, DAILY_QUOTA_BODY))
        with pytest.raises(RuntimeError, match="AIの無料枠を使い切りました"):
            t.transcribe(b"img")


class TestShrinkForUpload:
    """添付画像はボディ上限(実測: base64 6.00MBは通る/6.66MBは400)に収める"""

    def test_長辺1600pxのJPEGに落とす(self):
        raw = noisy_jpeg(2400, 1800)
        assert len(raw) > SHRINK_SKIP_BYTES
        shrunk, image_format = shrink_for_upload([(raw, "jpeg")])[0]
        assert image_format == "jpeg"
        assert max(Image.open(io.BytesIO(shrunk)).size) == MAX_IMAGE_EDGE
        assert len(shrunk) < len(raw)

    def test_最悪ケースの4枚でもボディ上限に収まる(self):
        # フロントは1枚4MB・4枚まで許すので、そのままだと合計16MBが来うる
        raw = noisy_jpeg(2400, 1800)
        total = sum(len(b) for b, _ in shrink_for_upload([(raw, "jpeg")] * 4))
        assert total * 4 / 3 < 6_000_000  # base64は4/3倍

    def test_小さい画像はそのまま渡す(self):
        # スクリーンショットのPNGを不用意にJPEGへ焼き直すと細い文字がにじむ
        small = noisy_jpeg(200, 150)
        assert len(small) <= SHRINK_SKIP_BYTES
        assert shrink_for_upload([(small, "png")]) == [(small, "png")]

    def test_読めない画像はそのまま渡す(self):
        # 縮小に失敗しても質問ごと落とさない(縮小を入れる前と同じ振る舞い)
        broken = b"\x89PNG" + os.urandom(SHRINK_SKIP_BYTES)
        assert shrink_for_upload([(broken, "png")]) == [(broken, "png")]

    def test_透過は白で埋める(self):
        # RGBへ変換するだけだと透過部分が黒地になり、黒文字が沈んで読めなくなる
        image = Image.new("RGBA", (900, 700), (0, 0, 0, 0))
        noise = Image.frombytes("RGB", (450, 700), os.urandom(450 * 700 * 3))
        image.paste(noise.convert("RGBA"), (0, 0))
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        shrunk, image_format = shrink_for_upload([(buf.getvalue(), "png")])[0]
        assert image_format == "jpeg"
        pixel = Image.open(io.BytesIO(shrunk)).convert("RGB").getpixel((880, 690))
        assert min(pixel) > 240  # JPEGのにじみを見込んでもほぼ白

    def test_describeも縮めてから投げる(self):
        raw = noisy_jpeg(2400, 1800)
        t = transcriber()
        t.describe([(raw, "jpeg")])
        url = sent_content(t)[0]["image_url"]["url"]
        sent = base64.b64decode(url.split(",", 1)[1])
        assert max(Image.open(io.BytesIO(sent)).size) == MAX_IMAGE_EDGE

    def test_縮小済みの画像は焼き直さない(self):
        # main.retrieve() が縮めた画像は、describe と _build_messages の
        # 手前に残した安全網へもう一度渡ってくる。長辺1600pxでも実測1.07MBあり
        # SHRINK_SKIP_BYTES(700KB)を超えるので、以前はそのたびに焼き直され、
        # 再圧縮で細い文字がにじんでいた(実測で合計3回)
        once = shrink_for_upload([(noisy_jpeg(2400, 1800), "jpeg")])[0]
        assert len(once[0]) > SHRINK_SKIP_BYTES  # 素通しの条件には引っかからない
        twice = shrink_for_upload([once])[0]
        assert twice[0] is once[0]  # バイト列ごと同じ = 焼き直していない

    def test_長辺が足りていても重すぎるJPEGは縮める(self):
        # 「もう縮小済み」の判定を大きさだけでやると、フロントが許す
        # 1枚4MBのJPEG(長辺1600px以内)が素通しし、4枚でボディ上限を超える
        heavy = Image.frombytes(
            "RGB", (1600, 1200), os.urandom(1600 * 1200 * 3)
        )
        buf = io.BytesIO()
        heavy.save(buf, format="JPEG", quality=100)
        raw = buf.getvalue()
        assert max(Image.open(io.BytesIO(raw)).size) <= MAX_IMAGE_EDGE
        assert len(raw) > SHRINK_DONE_BYTES
        shrunk, _ = shrink_for_upload([(raw, "jpeg")])[0]
        assert len(shrunk) < len(raw)

    def test_Exifで回っている画像は素通しさせない(self):
        # 大きさが足りていても、向きを起こさないと横倒しの文字を読ませることになる
        image = Image.frombytes("RGB", (1200, 900), os.urandom(1200 * 900 * 3))
        exif = image.getexif()
        exif[0x0112] = 6  # 右90度回転
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=85, exif=exif)
        raw = buf.getvalue()
        assert SHRINK_SKIP_BYTES < len(raw) <= SHRINK_DONE_BYTES
        shrunk, _ = shrink_for_upload([(raw, "jpeg")])[0]
        assert Image.open(io.BytesIO(shrunk)).size == (900, 1200)  # 起きている

    def test_書き起こしのページ画像は縮めない(self):
        # render_page_jpeg の出力は実測で最大244KB。二重に潰すと文字が読めなくなる
        raw = noisy_jpeg(2400, 1800)
        t = transcriber()
        t.transcribe(raw)
        url = sent_content(t)[0]["image_url"]["url"]
        assert base64.b64decode(url.split(",", 1)[1]) == raw


class TestCreateTranscriber:
    def test_workers_aiには鍵が要る(self, monkeypatch):
        monkeypatch.setenv("ANSWER_PROVIDER", "workers_ai")
        monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
        monkeypatch.delenv("CF_API_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match="ANSWER_PROVIDER=workers_ai"):
            create_transcriber()

    def test_workers_aiを選べる(self, monkeypatch):
        monkeypatch.setenv("ANSWER_PROVIDER", "workers_ai")
        monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
        monkeypatch.setenv("CF_API_TOKEN", "tok")
        monkeypatch.delenv("CF_VISION_MODEL", raising=False)
        t = create_transcriber()
        assert isinstance(t, WorkersAiTranscriber)
        # 回答生成と同じgemma。qwen3.8-27bは1ページ125ニューロンで無料枠を食い潰す
        assert t.model == "@cf/google/gemma-4-26b-a4b-it"
        assert "acct/ai/v1" in str(t.client.base_url)

    def test_モデルはenvで差し替えられる(self, monkeypatch):
        monkeypatch.setenv("ANSWER_PROVIDER", "workers_ai")
        monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
        monkeypatch.setenv("CF_API_TOKEN", "tok")
        monkeypatch.setenv("CF_VISION_MODEL", "@cf/qwen/qwen3.8-27b")
        assert create_transcriber().model == "@cf/qwen/qwen3.8-27b"

    def test_既定はNullTranscriberのまま(self, monkeypatch):
        monkeypatch.delenv("ANSWER_PROVIDER", raising=False)
        t = create_transcriber()
        assert type(t).__name__ == "NullTranscriber"
        assert t.enabled is False
