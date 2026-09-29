"""画像からテキストを書き起こすプロバイダ(スキャンPDF対応の心臓部)。

専用のOCRエンジンではなく、マルチモーダルLLMの画像認識を使う。
日本語・レイアウト・図表の説明までこなせるのが従来型OCRとの違い。

- NullTranscriber: ローカル開発用。書き起こさない(AWS不要)
- BedrockTranscriber: AWS時代の本番用。Claudeが読む
- WorkersAiTranscriber: 移行後の本番用。Cloudflare Workers AI の gemma が読む

回答生成と同じ ANSWER_PROVIDER=stub|bedrock|workers_ai で切り替える
(読む側と答える側でモデルの提供元がずれると、片方だけ鍵が無い状態に気づけない)。
"""

import base64
import io
import logging
import os

import pypdfium2 as pdfium  # type: ignore[import-untyped]
from PIL import Image, ImageOps  # type: ignore[import-untyped]

# 思考を止めるフラグと、Workers AI の叩き方(日次枠切れの429を再試行しない)は
# 回答生成と同じものを使う(定義は llm.py に1つだけ置く。2箇所に書くと
# 片方だけ直したときに、書き起こしだけ空で返るようになる)
from llm import NO_THINKING_EXTRA_BODY, _call_workers_ai

logger = logging.getLogger("uvicorn.error")

# 1ドキュメントあたりの書き起こし上限ページ数(コスト暴走の安全弁。
# 際限なく呼ばないための歯止めで、超えたページは空のまま素通しになる)。
#
# 30では足りなかった。全ページが画像の36ページの資料で6ページ分が
# 検索に出てこない状態になっていたため60に上げた。
# 費用は1ページ数円に満たず、60ページでも問題にならない。
# (移行後のWorkers AIでは1日の無料枠=10,000ニューロンが実質の上限になり、
#  1ページ40〜70ニューロンなので1日150〜200ページ程度が目安)
MAX_TRANSCRIBE_PAGES = 60

TRANSCRIBE_PROMPT = (
    "これは社内マニュアルの1ページです。画像に含まれるすべてのテキストを、"
    "内容の順序が伝わる形で書き起こしてください。図や表がある場合は、"
    "その内容を簡潔な文章で説明してください。書き起こし結果だけを出力してください。"
)

# Workers AI 側でだけ TRANSCRIBE_PROMPT の末尾に足す補足。
# 定数本体を書き換えると Bedrock 版(切り替え日まで本番)の挙動まで変わってしまう
VERBATIM_ADDENDUM = (
    "前置き・見出し・感想を足さないでください。"
    "画像に書かれている文字だけを、書かれている順序のまま出力してください。"
    "画像に文字が無い場合は、断り書きも含めて何も出力しないでください。"
)

DESCRIBE_PROMPT = (
    "これらの画像は社内マニュアル検索への質問に添付されたものです。"
    "画像に写っている内容(画面名、エラーメッセージ、システム名、操作対象など)を、"
    "マニュアル検索のキーワードとして使える形で簡潔に抜き出してください。"
    "複数枚ある場合は、全体をまとめて1つの説明文にしてください。"
    "説明文だけを出力してください。"
)


# 書き起こし・説明が失敗したときの「実際の返り方」は空文字ではなく断り文。
# 実測(真っ白な200x200のJPEGを transcribe に投げた結果、例外にはならない):
#   『申し訳ありませんが、提供された画像は真っ白な空白の画像であり、テキスト、図、
#     または表が含まれていません。そのため、書き起こしを行うことができません。』
#   VERBATIM_ADDENDUM を足してもこの形は消えなかった。
# describe 側は『画像が添付されていないようです。…』を返す。
# 空文字だけを見張っていると、この断り文が白紙ページの本文として
# chunking を通り、マニュアル本文として検索に載る
REFUSAL_PREFIXES = ("申し訳", "すみません", "ごめんなさい", "残念ながら")
# 実測で観測した断り方だけを並べる。『できません』『ありません』まで入れると
# 実在するページ本文を落とす。書き起こしに回るのは文字がほとんど無いページなので、
#   『画像の無断転載はできません。』(14字)
#   『この画像に該当する手順はありません。次ページへ進んでください。』(31字)
# のような著作権表記・区切りページが現実に当たり、本文がこの判定で消えていた。
# 下の並びなら実測の断り文2種(白紙ページ・画像なし)は両方とも捕まえたまま、
# この2文は通る
REFUSAL_MARKERS = (
    "含まれていません",
    "見当たりません",
    "添付されていない",
    "認識できない",
    "書き起こしを行うことができません",
)
# 断り文はどれも短い(実測28〜74文字)。長文まで疑うと、本文に
# 「〜は含まれていません」と書かれている本物のページを捨ててしまう。
# 本番データの写し(ManualChunk 4424件)で150文字以下は872件あり、
# そのうち上のマーカーに当たるのは本物の断り文4件だけ・最長145文字だった。
# 150では余裕が5文字しか無く、少し長い断り方が来ると素通しするので広げる
REFUSAL_MAX_CHARS = 300

# 質問に添えた画像を投げる前に縮める基準。Workers AI のリクエストボディには
# 上限があり、実測で生4.50MB(base64 6.00MB)は通る/生5.00MB(base64 6.66MB)は
# 400 "request body exceeds the maximum supported size" になる。
# スマホ写真は1枚2〜6MBあるので、フロントの上限(1枚4MB・4枚まで=合計16MB)では
# 2枚添えた時点で確実に超える。長辺1600px・品質85なら1枚あたり数百KBに収まり、
# 画面の文字も読める大きさが残る。
# 取り込み時のページ画像(render_page_jpeg)は実測で最大244KBなので通す必要が無い
MAX_IMAGE_EDGE = 1600
SHRINK_JPEG_QUALITY = 85
# これ以下はそのまま渡す。スクリーンショットのPNGを不用意にJPEGへ焼き直すと
# 細い文字がにじむため。4枚でも生2.8MB(base64 3.7MB)に収まる大きさ
SHRINK_SKIP_BYTES = 700_000
# 「もう縮める必要が無い」と見なす大きさ。shrink_for_upload は
# describe と _build_messages の手前にも残してあり(直接呼ぶ経路のための安全網)、
# main.retrieve() が縮めた画像はそこへもう一度渡ってくる。
# 長辺1600px・品質85の出力は実測1.07MB(圧縮の効かないノイズ画像の最悪ケース)で
# SHRINK_SKIP_BYTES を超えるため、素通しどころか2回余計に焼き直されていた
# (実測3回。焼き直すたびに再圧縮で細い文字がにじむ)。
# 上限は「4枚でもボディ上限に収まるか」で決める:
#   base64 6.00MB × 3/4 ÷ 4枚 ≒ 1.12MB
SHRINK_DONE_BYTES = 1_100_000
# Exifの向き(縦横の回転)を持つ画像は、大きさが足りていても起こす必要がある
_EXIF_ORIENTATION = 0x0112


def _looks_like_refusal(text: str) -> bool:
    """モデルが書き起こし(説明)を断ってきた文かどうか"""
    body = text.strip()
    if not body or len(body) > REFUSAL_MAX_CHARS:
        return False
    if body.startswith(REFUSAL_PREFIXES):
        return True
    # 「画像が添付されていないようです」のように、画像そのものを
    # 否定している短文も断り文とみなす
    return "画像" in body and any(marker in body for marker in REFUSAL_MARKERS)


def shrink_for_upload(
    images: list[tuple[bytes, str]],
) -> list[tuple[bytes, str]]:
    """質問に添えた画像を、リクエストボディの上限に収まる大きさへ落とす。

    回答生成(llm._build_messages)と説明文の生成(describe)の両方が通る。
    どちらか片方だけ縮めても、もう一方で400になって同じ質問が落ちるため。
    """
    return [_shrink_one(image_bytes, fmt) for image_bytes, fmt in images]


def _shrink_one(image_bytes: bytes, image_format: str) -> tuple[bytes, str]:
    if len(image_bytes) <= SHRINK_SKIP_BYTES:
        return image_bytes, image_format
    try:
        with Image.open(io.BytesIO(image_bytes)) as opened:
            width, height = opened.size
            # 既にこの関数の出力と同じ姿(長辺1600px以内のRGB JPEG・向きも正)で、
            # 4枚送ってもボディ上限に収まる大きさなら、焼き直さずそのまま返す。
            # ここを素通しにしないと、retrieve() が縮めた画像が describe と
            # _build_messages でもう一度JPEGに焼き直され、CPUを使ったうえに
            # 画質だけが落ちる(0.5vCPUのCloud Runでは待ち時間にも出る)
            if (
                opened.format == "JPEG"
                and opened.mode == "RGB"
                and max(width, height) <= MAX_IMAGE_EDGE
                and len(image_bytes) <= SHRINK_DONE_BYTES
                and opened.getexif().get(_EXIF_ORIENTATION, 1) == 1
            ):
                return image_bytes, image_format
            # JPEGは読み込みの段階で粗く間引いてもらう(draft)。
            # 4032x3024を4枚で実測0.94秒→0.58秒。0.5vCPUのコンテナでは効く。
            # 縮小後の寸法を渡すのが肝で、(1600,1600)のような正方形を渡すと
            # 短辺が足りず間引きが効かない。JPEG以外では何も起きない
            scale = max(width, height) / MAX_IMAGE_EDGE
            if scale > 1:
                opened.draft("RGB", (round(width / scale), round(height / scale)))
            # スマホ写真は向きがExifにしか入っていないことがある。
            # 起こしてから縮めないと、横倒しの文字を読ませることになる
            image = ImageOps.exif_transpose(opened)
            image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
            if image.mode != "RGB":
                # 透過は白で埋める(RGBへ変換するだけだと黒地になり文字が沈む)
                canvas = Image.new("RGB", image.size, (255, 255, 255))
                rgba = image.convert("RGBA")
                canvas.paste(rgba, mask=rgba.split()[-1])
                image = canvas
            buf = io.BytesIO()
            image.save(buf, format="JPEG", quality=SHRINK_JPEG_QUALITY)
    except Exception as e:
        # 縮小できない画像で質問ごと落とさない。そのまま投げれば、
        # 上限を超えていれば400・平気なら通る(縮小を入れる前と同じ振る舞い)
        logger.warning("添付画像を縮小できませんでした(そのまま送ります): %s", e)
        return image_bytes, image_format
    shrunk = buf.getvalue()
    if len(shrunk) >= len(image_bytes):
        # 縮めたつもりで太ることがある(元がJPEGで既に小さいとき)
        return image_bytes, image_format
    return shrunk, "jpeg"


def render_page_jpeg(pdf_bytes: bytes, page_index: int, scale: float = 2.0) -> bytes:
    """PDFの1ページをJPEG画像に変換する(scale=2.0 ≒ 144dpi)"""
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[page_index]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        buf = io.BytesIO()
        # JPEGはスキャン画像の圧縮率が高く、Bedrockのサイズ上限(約3.75MB)に収めやすい
        image.convert("RGB").save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    finally:
        doc.close()


class NullTranscriber:
    """開発用(AWS無し): 書き起こしをしない。スキャンページは空のまま"""

    enabled = False

    def transcribe(self, image_bytes: bytes) -> str:
        return ""

    def describe(self, images: list[tuple[bytes, str]]) -> str:
        return ""


class BedrockTranscriber:
    """Claudeの画像認識でページ画像をテキスト化する"""

    enabled = True

    def __init__(self, model_id: str, region: str):
        from bedrock import create_bedrock_client

        # 画像の書き起こしは1ページあたり時間がかかるため読み取り待ちを長めに取る
        self.client = create_bedrock_client(region, read_timeout=120)
        self.model_id = model_id

    def transcribe(self, image_bytes: bytes) -> str:
        text = self._ask_about_images([(image_bytes, "jpeg")], TRANSCRIBE_PROMPT, 2048)
        # Workers AI 版と同じく断り文をここで止める。止めないと白紙・区切りページの
        # 本文が断り文に置き換わり、chunking を通ってマニュアル本文として検索に載る。
        # 本番データの写しに残っている汚染4件はこの経路で入ったもので、
        # 切り替え日まではこちらが本番なので、直さないと汚染が増え続ける。
        # 例外にすれば main.py:539 の transcribe_page が握りつぶし、
        # そのページは元のまま(空)で素通しになる = 今までの「書き起こせなかった
        # ページ」と同じ扱いに戻るだけで、取り込み全体は止まらない
        if _looks_like_refusal(text):
            raise RuntimeError(f"画像の書き起こし結果が断り文でした: {text.strip()[:40]}")
        return text

    def describe(self, images: list[tuple[bytes, str]]) -> str:
        """チャット添付画像を、ベクトル検索に使えるキーワード文に変換する。

        複数枚あっても1回の問い合わせでまとめて見せる。1枚ずつ聞くより速く、
        「1枚目の画面から2枚目へ進んだ」のような関係も拾える
        """
        if not images:
            return ""
        return self._ask_about_images(images, DESCRIBE_PROMPT, 512)

    def _ask_about_images(
        self, images: list[tuple[bytes, str]], prompt: str, max_tokens: int
    ) -> str:
        content: list[dict] = [
            {"image": {"format": image_format, "source": {"bytes": image_bytes}}}
            for image_bytes, image_format in images
        ]
        content.append({"text": prompt})
        res = self.client.converse(
            modelId=self.model_id,
            messages=[{"role": "user", "content": content}],
            inferenceConfig={"maxTokens": max_tokens, "temperature": 0},
        )
        return res["output"]["message"]["content"][0]["text"]


class WorkersAiTranscriber:
    """Cloudflare Workers AI(既定は gemma)の画像認識でページ画像をテキスト化する。

    Bedrock 版と同じ3つ(enabled / transcribe / describe)を持ち、
    main.py からは見分けが付かないように振る舞う。
    """

    enabled = True

    def __init__(self, model: str, client=None):
        # client を差し替えられるのはテストで openai SDK を偽物にするため
        if client is None:
            # 回答生成と同じ鍵・同じエンドポイントを使うので、
            # クライアントの作り方も llm 側に1つだけ置いたものを借りる
            # (鍵が無いときの文言も ANSWER_PROVIDER=workers_ai で揃う)
            from llm import _create_workers_ai_client

            # 画像の書き起こしは1ページあたり時間がかかるため
            # 読み取り待ちを長めに取る(Bedrock版の read_timeout=120 と同じ考え方)
            client = _create_workers_ai_client(timeout=120.0)
        self.client = client
        self.model = model

    def transcribe(self, image_bytes: bytes) -> str:
        # 共有の TRANSCRIBE_PROMPT だけだと、gemma は
        # 「この画像は、社内マニュアルの…を説明するページです」という前置きと
        # **見出し** 装飾、さらに「アイコン:星のマーク」といった感想まで足してくる。
        # 書き起こしはそのまま検索対象の本文になるので、余計な文が入ると
        # 実際には書かれていない語で検索に引っかかるようになる。
        # 定数そのものは Bedrock 版も使っているため書き換えず、こちら側でだけ足す
        text = self._ask_about_images(
            [(image_bytes, "jpeg")], TRANSCRIBE_PROMPT + VERBATIM_ADDENDUM, 2048
        )
        if not text.strip():
            # 空文字を返すと main.py 側は「書き起こせたが中身が無いページ」として
            # 素通しし、失敗に気づけない。1ページの失敗は呼び出し側が握りつぶすので、
            # ここは例外にしてよい(main.py:509)
            raise RuntimeError("画像の書き起こし結果が空でした")
        if _looks_like_refusal(text):
            # 断り文をそのまま返すと、白紙・区切りページの本文がこの文に
            # 置き換わり、chunking を通ってマニュアル本文として検索に載る。
            # 例外にすれば main.py:509 が握りつぶし、そのページは元のまま素通しになる
            raise RuntimeError(f"画像の書き起こし結果が断り文でした: {text.strip()[:40]}")
        return text

    def describe(self, images: list[tuple[bytes, str]]) -> str:
        """チャット添付画像を、ベクトル検索に使えるキーワード文に変換する。

        複数枚あっても1回の問い合わせでまとめて見せる(Bedrock版と同じ)。

        ここは何があっても例外を投げない。呼び出し元の main.py:742 retrieve() は
        describe を素で呼んでいて(/search は main.py:773 でそれを素で呼ぶ)、
        例外を上げると画像を添えた質問がまるごと HTTP 500 になる。
        実測: 9x9 の PNG を1枚添付して /search → 500
        (Workers AI は10px未満の画像を400で拒否する)。
        説明文は検索語を増やすための味付けで、無くても検索は成立するので、
        失敗したら空文字を返して質問文だけで検索を続ける
        (NullTranscriber/BedrockTranscriber も空文字を返す前提で
         main.py は `if description:` と書かれている)
        """
        if not images:
            return ""
        try:
            text = self._ask_about_images(
                shrink_for_upload(images), DESCRIBE_PROMPT, 512
            )
        except Exception as e:
            logger.warning("添付画像の説明に失敗しました(画像なしで検索します): %s", e)
            return ""
        if not text.strip():
            return ""
        if _looks_like_refusal(text):
            # 『画像が添付されていないようです。…』も実測で返る。
            # 検索キーワードに足すと、まるで関係の無い語で検索することになる
            logger.warning("添付画像の説明が断り文でした: %s", text.strip()[:40])
            return ""
        return text

    def _ask_about_images(
        self, images: list[tuple[bytes, str]], prompt: str, max_tokens: int
    ) -> str:
        # 画像は data URI にして content 配列で渡す(OpenAI互換の作法)。
        # ALLOWED_IMAGE_FORMATS の png/jpeg/webp/gif は4形式とも実機で通した
        content: list[dict] = [
            {
                "type": "image_url",
                "image_url": {
                    "url": (
                        f"data:image/{image_format};base64,"
                        + base64.b64encode(image_bytes).decode("ascii")
                    )
                },
            }
            for image_bytes, image_format in images
        ]
        content.append({"type": "text", "text": prompt})
        # 再試行の作法(日次枠切れの429は投げ直さない)も回答生成と揃える
        res = _call_workers_ai(
            self.client.chat.completions.create,
            model=self.model,
            messages=[{"role": "user", "content": content}],
            max_tokens=max_tokens,
            temperature=0,
            # 思考を切らないと max_tokens を英語の独り言で使い切り、
            # 書き起こしが空で返る(理由は llm.py の同名の定数を参照)
            extra_body=NO_THINKING_EXTRA_BODY,
        )
        # 空だったときにどうするかは呼び出し側で決める。
        # transcribe は例外(そのページを諦める)、describe は空文字(検索は続ける)
        return res.choices[0].message.content or ""


def create_transcriber():
    # 回答生成と同じスイッチで有効化(読む側と答える側は同じ提供元に揃える)
    provider = os.environ.get("ANSWER_PROVIDER", "stub")
    if provider == "workers_ai":
        # 既定は回答生成と同じ gemma。vision:true で日本語のスクリーンショットも
        # 実マニュアルのページ画像も正しく書き起こせることを実機で確認した。
        # qwen3.8-27b に替えると1ページ125ニューロン(gemmaは7〜11)になり、
        # 60ページのPDF 1本で1日の無料枠10,000をほぼ使い切るので注意
        return WorkersAiTranscriber(
            model=os.environ.get("CF_VISION_MODEL", "@cf/google/gemma-4-26b-a4b-it"),
        )
    if provider == "bedrock":
        return BedrockTranscriber(
            model_id=os.environ.get(
                "BEDROCK_CHAT_MODEL_ID",
                "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
            ),
            region=os.environ.get("AWS_REGION", "ap-northeast-1"),
        )
    return NullTranscriber()
