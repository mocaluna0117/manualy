# 必ず一番上に置く。マウントした秘密のJSONを環境変数へ展開する副作用だけの
# モジュールで、importした時点で読み込みが走る。security.py と embedding.py は
# importされた時点で os.environ を読むので、ここより後ろに置くと間に合わない
import secrets_file  # noqa: F401  isort:skip

import base64
import json
import logging
import os
import re
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import psycopg
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import UUID4, BaseModel
from pypdf import PdfReader

from chunking import split_text
from extract import extractor_for
from security import fetch_file, require_api_token
from embedding import create_embedder, to_vector_literal
from llm import ADMIN_TOOLS, Context, create_answer_generator
from vision import MAX_TRANSCRIBE_PAGES, create_transcriber, render_page_jpeg

load_dotenv()  # rag/.env を読み込む

DATABASE_URL = os.environ["DATABASE_URL"]

# 検索と保存で使うベクトルの列。移行中は embedding(Titan V2) と
# どの列のベクトルを見るか。別モデルのベクトルは比べられないので、
# 混ぜると検索が静かに壊れる。
# 列名はSQLに直接埋め込むため、許可した名前以外は起動時に止める。
#
# 2026-09-12 に旧 embedding 列(Titan)を落としたので、いまは embedding_v2 だけ。
# 既定を "embedding" のままにしておくと、環境変数を渡し忘れたデプロイが
# 「列が無い」で全滅する。既定を実在する列にしておく
EMBEDDING_COLUMN = os.environ.get("EMBEDDING_COLUMN", "embedding_v2")
_ALLOWED_EMBEDDING_COLUMNS = ("embedding_v2",)
if EMBEDDING_COLUMN not in _ALLOWED_EMBEDDING_COLUMNS:
    raise RuntimeError(
        f"EMBEDDING_COLUMN={EMBEDDING_COLUMN!r} は使えません。"
        f"使えるのは {' / '.join(_ALLOWED_EMBEDDING_COLUMNS)} です"
    )

# RDSのTLS証明書を検証するためのCAの場所(本番のみ設定される)。
# psycopgの sslmode=require は「暗号化するが相手が本物か確認しない」なので、
# CAがあるときは verify-full にして中間者攻撃を検知できる状態にする。
_DB_SSL_CA = os.environ.get("DATABASE_SSL_CA")
_DB_SSL_ARGS = (
    {"sslmode": "verify-full", "sslrootcert": _DB_SSL_CA} if _DB_SSL_CA else {}
)


def _needs_ssl_ca(url: str) -> bool:
    """CAが要る宛先(=公衆網の向こうのSupabase)かどうか。

    Supabaseの証明書は公的CAではなく自前のCAで署名されているので、
    CAを渡さないと psycopg は sslmode 既定の prefer で繋ぐ。
    暗号化はされても相手が本物かを確認しないため、盗聴には強くても
    なりすましには無防備なまま気づけない(接続は普通に成功する)。
    接続文字列側で sslrootcert を渡している場合はそれで検証されるので通す。
    """
    parsed = urllib.parse.urlsplit(url)
    if "supabase" not in (parsed.hostname or ""):
        return False
    return "sslrootcert" not in urllib.parse.parse_qs(parsed.query)


if not _DB_SSL_CA and _needs_ssl_ca(DATABASE_URL):
    # 黙って無検証で繋がない。Cloud Run で DATABASE_SSL_CA の渡し忘れがあれば
    # 起動しないことで気づける(イメージには /app/certs/supabase-ca.crt が入っている)。
    # AWS(RDS)とローカルの宛先はここに引っかからないので今までどおり起動する
    raise RuntimeError(
        "DATABASE_URL が Supabase を指していますが DATABASE_SSL_CA が未設定です。"
        "このままでは相手の証明書を検証せずに接続します。"
        "DATABASE_SSL_CA=/app/certs/supabase-ca.crt を渡してください"
    )


def db_connect():
    """DBに接続する。本番ではTLS証明書の検証付き。"""
    return psycopg.connect(DATABASE_URL, **_DB_SSL_ARGS)



# 康熙部首・CJK部首補助(⽅ U+2F58 など)を通常の漢字(方)に畳むための対応表。
# macOSのフォントを埋め込んだPDFはToUnicodeが部首側を指すことがあり、
# そのまま取り込むと「使い方」で検索しても「使い⽅」に一致しない。
# NFCでは畳まれない(NFKC相当の互換分解)ため、部首ブロックだけを対象に畳む
_RADICALS = re.compile(r"[\u2E80-\u2EF3\u2F00-\u2FD5]")


def normalize_text(text: str) -> str:
    """検索で同一視したい表記ゆれを吸収する(NFC + 部首の畳み込み)。"""
    text = _RADICALS.sub(lambda m: unicodedata.normalize("NFKC", m.group()), text)
    return unicodedata.normalize("NFC", text)


logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="Manual Search RAG Service")
embedder = create_embedder()
answer_generator = create_answer_generator()
transcriber = create_transcriber()

# これ未満の文字数しか取れないページは「実質画像のページ」とみなし書き起こしに回す
MIN_TEXT_CHARS_PER_PAGE = 20

# ページの書き起こしを何本まで並べて投げるか。
# 待ちの大半はBedrockの応答なので並べると速くなるが、ページ画像の生成は
# CPUとメモリを使う。0.5 vCPU/1GBで詰まらない範囲に抑える
TRANSCRIBE_WORKERS = 4


ALLOWED_IMAGE_FORMATS = {"png", "jpeg", "webp", "gif"}


class HistoryMessage(BaseModel):
    role: str  # 'user' | 'assistant'
    content: str


class QuestionImage(BaseModel):
    """質問に添付された画像1枚"""

    base64: str
    format: str  # png / jpeg / webp / gif


class SearchRequest(BaseModel):
    question: str
    images: list[QuestionImage] = []  # 質問に添付された画像(任意・複数可)
    # 1枚だけ渡していた頃の呼び出し方。入れ替えの途中でも受け取れるように残す
    image_base64: str | None = None
    image_format: str | None = None
    history: list[HistoryMessage] = []  # 同じ会話のこれまでのやりとり(絞り込み対話用)
    is_admin: bool = False  # trueなら管理ツール(フォルダ作成・再分類)をClaudeに渡す


class Citation(BaseModel):
    """回答の根拠となったマニュアルの断片"""

    manual_id: str
    title: str
    snippet: str
    page: int | None = None  # 元PDFの何ページ目か


class ActionRequest(BaseModel):
    """Claudeが要求した管理操作。実行するのはNestJS側"""

    name: str
    input: dict = {}


class SearchResponse(BaseModel):
    answer: str
    citations: list[Citation]
    options: list[str] = []  # 絞り込み質問の選択肢(ボタン表示用)
    actions: list[ActionRequest] = []  # 管理ツールの呼び出し要求(管理者のみ)
    # マニュアルから答えられたか。True=抜粋を根拠に回答、
    # False=モデルが「[参照] なし」と申告(=答えられなかった)、
    # None=判断材料がない(管理操作・検索対象ゼロ・生成失敗・申告なし)。
    # 「どのマニュアルが足りないか」を後から集計するために保存側へ渡す
    answered: bool | None = None
    # 判定できなかった理由まで分かるようにする(answeredはここから導いている)
    outcome: str | None = None


OPTION_PATTERN = re.compile(r"^\[選択肢\]\s*(.+)$", re.MULTILINE)
REFERENCE_PATTERN = re.compile(r"^\[参照\]\s*(.*)$", re.MULTILINE)


# 回答の結末。「答えられたか」だけだと、聞き返し・管理操作・生成失敗が
# すべて「判定できず」に混ざり、集計を見ても何も分からなくなる
OUTCOME_ANSWERED = "answered"  # 抜粋を根拠に答えた
OUTCOME_NO_BASIS = "no_basis"  # 根拠が無いと申告した(=答えられなかった)
OUTCOME_CLARIFY = "clarify"  # 聞き返した(絞り込み質問)。まだ続きがある
OUTCOME_ADMIN = "admin"  # 管理操作(フォルダ作成など)の応答
OUTCOME_FAILED = "failed"  # 回答文の生成に失敗した
OUTCOME_UNREPORTED = "unreported"  # 通常の回答だが[参照]の申告が無かった
OUTCOME_NO_MANUALS = "no_manuals"  # そもそも検索できるマニュアルが無い


def decide_outcome(
    actions: list, used: list[int] | None, options: list[str]
) -> tuple[str, bool | None]:
    """回答の結末と、集計用の「答えられたか」を決める。

    答えられたか(bool)は結末から導く。判定できるのは、抜粋を根拠にしたと
    申告した場合と、根拠が無いと申告した場合の2つだけ。
    """
    if actions:
        outcome = OUTCOME_ADMIN  # マニュアルへの質問ではない
    elif used:
        outcome = OUTCOME_ANSWERED
    elif options:
        # 聞き返しは「答えられなかった」ではない。ここを混ぜると
        # 「作るべきマニュアル」の一覧が聞き返しだらけになる
        outcome = OUTCOME_CLARIFY
    elif used is None:
        outcome = OUTCOME_UNREPORTED  # 申告が無く、根拠にしたか分からない
    else:
        outcome = OUTCOME_NO_BASIS

    if outcome == OUTCOME_ANSWERED:
        return outcome, True
    if outcome == OUTCOME_NO_BASIS:
        return outcome, False
    return outcome, None


def extract_references(answer: str, total: int) -> tuple[str, list[int] | None]:
    """回答文から[参照]行を抜き出し、(本文, 使った抜粋のindexリスト)に分ける。

    戻りのリストがNone = 申告なし(保険の動作へ)、[] = 「[参照] なし」(引用ゼロ)。
    """
    m = REFERENCE_PATTERN.search(answer)
    if not m:
        return answer, None
    cleaned = REFERENCE_PATTERN.sub("", answer).strip()
    numbers = [int(n) for n in re.findall(r"\d+", m.group(1))]
    used = [n - 1 for n in numbers if 1 <= n <= total]
    return cleaned, used

TOP_K = 8  # Claudeに渡す抜粋の数


# RRFの定数。順位の差を緩やかにするための下駄で、元論文の推奨値。
# 小さくすると1位が強くなりすぎ、大きくすると順位の差が消える
RRF_K = 60


def fuse_by_rrf(routes: list[list[tuple]]) -> list[tuple]:
    """複数の検索ルートの結果を、順位の逆数の和で1つに並べ直す。

    score = Σ 1/(RRF_K + そのルートでの順位)。
    同じチャンクが複数のルートに出てくるほど強くなるので、
    「意味も近いし語も一致する」ものが上に来る。

    各行は (chunk_id, manual_id, title, content, page_number) の並び。
    先に見つけたルートの内容を採用する(どのルートでも中身は同じ)。
    """
    scores: dict[str, float] = {}
    meta: dict[str, tuple] = {}
    for rows in routes:
        for rank, row in enumerate(rows, start=1):
            scores[row[0]] = scores.get(row[0], 0.0) + 1.0 / (RRF_K + rank)
            meta.setdefault(row[0], row[1:5])

    ranked = sorted(scores, key=lambda cid: scores[cid], reverse=True)[:TOP_K]
    return [meta[cid] for cid in ranked]  # (manual_id, title, content, page_number)


# 鍵付き(管理者だけに見せる)フォルダの中身を、検索から外すための条件。
#
# 画面の一覧から隠すだけでは足りない。AIは検索で拾った抜粋を根拠に答えるので、
# 検索に残っていると回答文や引用として中身がそのまま出てしまう。
#
# 管理者の質問でも外す。鍵付きに入れるのは「業務の回答に使ってほしくない資料」
# (個人の資格試験の教材など)であることが多く、根拠の枠(TOP_K)は8件しかない。
# 業務の質問と語彙が近い資料が混ざると、本来出るべきマニュアルが押し出される。
# 管理者は画面のキーワード検索・閲覧・ダウンロードで中身に辿れるため、
# ここで外しても資料に触れなくなるわけではない。
# 未分類(categoryIdがnull)は誰でも見えるフォルダ外の資料なので対象外
HIDE_ADMIN_ONLY = """
              AND NOT EXISTS (
                  SELECT 1 FROM "ManualCategory" c
                  WHERE c.id = m."categoryId" AND c.admin_only
              )"""


def hybrid_search(cur, query_vec: str, terms: list[str]):
    """ベクトル・キーワード・タイトルの3ルートをRRF(Reciprocal Rank Fusion)で融合する。

    取り込みが完了していないマニュアル(差し替え直後・失敗)は検索対象から除く。
    そうしないと「新しいPDFに差し替わったのに旧版の内容で回答する」状態になる。
    ゴミ箱に入れたもの(deleted_at)も同様に除く。捨てたはずの内容を
    AIが引用してくるのを防ぐ。

    ベクトル検索は「意味の近さ」に強いが、電話番号・型番・固有名詞のような
    「文字通りの一致」に弱い。キーワード検索はその逆。タイトル検索は、
    本文に手がかりが無く文書名だけが頼りのマニュアル(記入見本など)を拾う。
    各ルートの順位を score = Σ 1/(60+順位) で足し合わせ、得意分野を活かす。
    """
    # ルート1: ベクトル検索(意味の近さ)
    #
    # 最近傍検索はManualChunk単体で完結させ、タイトルの取得(JOIN)は後段で行う。
    # JOINを含めたままORDER BY embeddingを書くと、Postgresが
    # 「JOINしてからソート」の計画を選びHNSWインデックスが使われなくなる。
    # AS MATERIALIZED でCTEのインライン展開も防ぎ、確実に索引を使わせる。
    # 内側は多めに取り、取り込み未完了ぶんを除いた後にTOPまで絞る
    # 鍵付きフォルダは誰の検索からも外す(理由はHIDE_ADMIN_ONLYの説明)
    hidden = HIDE_ADMIN_ONLY
    cur.execute(
        """
        WITH nearest AS MATERIALIZED (
            SELECT id, manual_id, content, page_number,
                   {column} <=> %s::vector AS distance
            FROM "ManualChunk"
            WHERE {column} IS NOT NULL
            ORDER BY distance
            LIMIT 40
        )
        SELECT n.id, n.manual_id, m.title, n.content, n.page_number
        FROM nearest n
        JOIN "Manual" m ON m.id = n.manual_id
        WHERE m.ingest_status = 'COMPLETED' AND m.deleted_at IS NULL
        {hidden}
        -- JOINを挟むと内側のORDER BYは保たれないので、距離で明示的に並べ直す。
        -- これを忘れるとRRFに渡る順位が崩れ、検索精度が静かに落ちる
        ORDER BY n.distance
        LIMIT 20
        """.format(hidden=hidden, column=EMBEDDING_COLUMN),
        (query_vec,),
    )
    vector_rows = cur.fetchall()

    # ルート2: キーワード一致(マッチしたキーワード数が多い順)
    #
    # ILIKEの条件をWHEREにも書くのが重要。SELECT句でhitsを数えるだけだと
    # 全チャンクを評価することになり、pg_trgmのインデックスが使われない
    keyword_rows = []
    title_rows = []
    if terms:
        patterns = [f"%{t}%" for t in terms]

        hit_expr = " + ".join(
            ["(CASE WHEN mc.content ILIKE %s THEN 1 ELSE 0 END)"] * len(terms)
        )
        any_match = " OR ".join(["mc.content ILIKE %s"] * len(terms))
        cur.execute(
            f"""
            SELECT mc.id, mc.manual_id, m.title, mc.content, mc.page_number,
                   ({hit_expr}) AS hits
            FROM "ManualChunk" mc
            JOIN "Manual" m ON m.id = mc.manual_id
            WHERE m.ingest_status = 'COMPLETED' AND m.deleted_at IS NULL
              AND ({any_match}){hidden}
            ORDER BY hits DESC
            LIMIT 20
            """,
            patterns + patterns,  # hit_expr用 と WHERE用
        )
        keyword_rows = [r for r in cur.fetchall() if r[5] > 0]

        # ルート3: タイトル一致(文書名そのものを探す質問に効く)
        #
        # ルート1・2は本文しか見ないため、本文に手がかりが無いマニュアル
        # (例: 記入見本のスキャンPDF)はタイトルでしか見つけられない。
        #
        # DISTINCT ON でマニュアルごとに先頭チャンク1件だけを代表にするのが重要。
        # 全チャンクを返すと、タイトルが一致したマニュアル1本が
        # キーワード順位の上位を占拠し、他のマニュアルを押し出してしまう
        title_hit_expr = " + ".join(
            ["(CASE WHEN m.title ILIKE %s THEN 1 ELSE 0 END)"] * len(terms)
        )
        title_any_match = " OR ".join(["m.title ILIKE %s"] * len(terms))
        cur.execute(
            f"""
            SELECT * FROM (
                SELECT DISTINCT ON (m.id)
                       mc.id, mc.manual_id, m.title, mc.content, mc.page_number,
                       ({title_hit_expr}) AS hits
                FROM "ManualChunk" mc
                JOIN "Manual" m ON m.id = mc.manual_id
                WHERE m.ingest_status = 'COMPLETED' AND m.deleted_at IS NULL
                  AND ({title_any_match}){hidden}
                ORDER BY m.id, mc.chunk_index
            ) t
            ORDER BY hits DESC
            LIMIT 20
            """,
            patterns + patterns,  # title_hit_expr用 と WHERE用
        )
        title_rows = cur.fetchall()

    return fuse_by_rrf([vector_rows, keyword_rows, title_rows])


# 前後に空白のあるスラッシュ。語中の「A/B工法」を割らないよう、空白を必須にする
MERGED_OPTION = re.compile(r"\s+[/／]\s+")


def split_merged_options(options: list[str]) -> list[str]:
    """1行に複数の案が書かれた選択肢を、案ごとに分ける。

    プロンプトでは「1行につき1つ」と決めているが、モデルが
    「[選択肢] A / B」と1行にまとめてしまうことがある。そのままだと
    どちらも選べない1個のボタンになり、利用者が先へ進めなくなる
    (実際にそう報告された)。受け取り側で割って救済する。
    """
    result: list[str] = []
    for option in options:
        parts = [p.strip() for p in MERGED_OPTION.split(option)]
        # 2文字未満の欠片しか作れないときは、割らずに元のまま残す
        parts = [p for p in parts if len(p) >= 2]
        result.extend(parts if len(parts) >= 2 else [option])
    return result


def extract_options(answer: str) -> tuple[str, list[str]]:
    """回答文から[選択肢]行を抜き出し、(本文, 選択肢リスト)に分ける"""
    options = [m.strip() for m in OPTION_PATTERN.findall(answer)]
    cleaned = OPTION_PATTERN.sub("", answer).strip()
    if not options:
        # 保険: モデルが形式を守らず「選択肢: 1. A / 2. B」のように書いた場合も救済する
        cleaned, options = _fallback_extract_options(cleaned)
    return cleaned, split_merged_options(options)


def _fallback_extract_options(answer: str) -> tuple[str, list[str]]:
    """文末付近の「選択肢: 1. A / 2. B / 3. C」パターンを解析してボタン化する保険"""
    idx = answer.rfind("選択肢")
    # 文末付近(400字以内)に無ければ、本文中の言及とみなして触らない
    if idx == -1 or len(answer) - idx > 400:
        return answer, []
    m = re.match(r"選択肢[：:]\s*(.+)\s*$", answer[idx:], re.DOTALL)
    if not m:
        return answer, []
    options = []
    for item in re.split(r"[/／\n]", m.group(1)):
        item = re.sub(r"^\s*\d+[.)]\s*", "", item).strip(" 　・*-")
        if 2 <= len(item) <= 50:
            options.append(item)
    if not (2 <= len(options) <= 5):
        return answer, []
    cleaned = answer[:idx].rstrip()
    # 直前に残った「次に知りたくなりそうなこと：」等の見出しを掃除
    # (コロンが**の内側/外側どちらにあっても消せるように)
    cleaned = re.sub(
        r"(?:\*\*)?次に知りたくなりそうなこと[：:]?(?:\*\*)?[：:]?\s*$", "", cleaned
    ).rstrip()
    return cleaned.strip(), options


class IngestRequest(BaseModel):
    manual_id: UUID4
    download_url: str  # NestJSが発行した署名付きURL
    # 元のファイル名。拡張子から読み方(PDF/Word/Excel/PowerPoint/メール)を決める。
    # 省略時はPDFとして扱う(この項目より前からある呼び出しとの互換のため)
    file_name: str = ""


class IngestResponse(BaseModel):
    manual_id: str
    page_count: int
    chunk_count: int
    transcribed_page_count: int = 0  # Claudeの画像認識で書き起こしたページ数
    # PDF自体が持つ作成日(ISO8601)。一覧の「作成日」列に使う。
    # 入っていないPDFもあるのでnullを許容する
    pdf_created_at: str | None = None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ingest", response_model=IngestResponse, dependencies=[Depends(require_api_token)])
def ingest(req: IngestRequest) -> IngestResponse:
    """ファイルを取り込み、テキスト抽出→チャンク分割→DB保存する。

    PDFはページごと、Excelはシートごと、PowerPointはスライドごとに分ける。
    WordとOutlookメールは区切りが無いので全体で1つとして扱う。
    embeddingはこの段階ではNULLのまま(次ステップでBedrockを使って埋める)。
    """
    # 1) 署名付きURLからファイルをダウンロード。
    #    スキーム/ホスト/解決先IPを検証し、サイズ上限とタイムアウトも掛ける
    #    (file://やメタデータエンドポイントを読ませられるのを防ぐ)
    file_bytes = fetch_file(req.download_url)

    pdf_created_at: str | None = None
    # 画像ページの書き起こし件数。PDF以外では書き起こしをしないので0のまま
    transcribed_count = 0
    extractor = extractor_for(req.file_name)

    if extractor is not None:
        # --- PDF以外(Word / Excel / PowerPoint / Outlookメール) ---
        try:
            sections = extractor(file_bytes)
        except Exception as e:
            logger.warning(
                "ファイルの解析に失敗 manual=%s file=%s: %s",
                req.manual_id,
                req.file_name,
                e,
            )
            raise HTTPException(
                status_code=422, detail="ファイルを解析できませんでした"
            )
        if not any(text.strip() for _label, text in sections):
            raise HTTPException(
                status_code=422,
                detail="このファイルからは文字を取り出せませんでした(中身が画像だけの可能性があります)",
            )
        # 見出し(シート名・スライド番号)を本文の先頭に付けて、
        # 「どのシートの話か」が抜粋だけでも分かるようにする
        pages = [
            normalize_text(f"{label}\n{text}" if label else text)
            for label, text in sections
        ]
    else:
        # --- PDF(従来の経路) ---
        try:
            reader = PdfReader(BytesIO(file_bytes))
            pages = [(page.extract_text() or "").strip() for page in reader.pages]
        except Exception as e:
            logger.warning("PDFの解析に失敗 manual=%s: %s", req.manual_id, e)
            raise HTTPException(status_code=422, detail="PDFを解析できませんでした")

        # PDF自体が持つ作成日を読む(一覧の「作成日」列に使う)。
        # 日付が壊れているPDFもあるので、取れなければ諦めて取り込みは続ける
        try:
            created = reader.metadata.creation_date if reader.metadata else None
            if created:
                pdf_created_at = created.isoformat()
        except Exception:
            pass

        # テキストがほぼ取れないページ(スキャン・画像ページ)は
        # Claudeの画像認識で書き起こす(上限ページ数まで)。
        #
        # 1ページあたり数秒かかり、待ち時間のほとんどはBedrockの応答待ち。
        # 全ページが画像のPDFだと1件で2分近くかかっていたので、
        # 数ページずつ並べて投げる。同時数は絞る(このコンテナは0.5 vCPU/1GBで、
        # ページ画像の生成が重い。増やしすぎると詰まってヘルスチェックに落ちる)
        if transcriber.enabled:
            targets = [
                i
                for i, text in enumerate(pages)
                if len(text) < MIN_TEXT_CHARS_PER_PAGE
            ][:MAX_TRANSCRIBE_PAGES]  # コストの安全弁。超過分は素通し(空ページ扱い)

            def transcribe_page(index: int) -> tuple[int, str | None]:
                try:
                    return index, transcriber.transcribe(
                        render_page_jpeg(file_bytes, index)
                    )
                except Exception:
                    # 1ページの失敗で取り込み全体を止めない(そのページだけ諦める)
                    return index, None

            if targets:
                with ThreadPoolExecutor(max_workers=TRANSCRIBE_WORKERS) as pool:
                    for index, text in pool.map(transcribe_page, targets):
                        if text is not None:
                            pages[index] = text
                            transcribed_count += 1

        # 表記をNFCに正規化する。PDFの内部表現によってはNFDで抽出されることが
        # あり、そのまま保存すると検索キーワード(NFC)のILIKEに当たらなくなる
        pages = [normalize_text(text) for text in pages]

    # 3) 区切りごとにチャンク化する(どこ由来かを記録し、引用の手がかりにする)
    chunks: list[tuple[str, int]] = []  # (本文, ページ/シート/スライドの番号)
    for page_no, text in enumerate(pages, start=1):
        for piece in split_text(text):
            chunks.append((piece, page_no))

    # 4) 各チャンクを「タイトル\n本文」の形でベクトル化する。
    #    本文に手がかりが無いチャンク(記入見本・表紙など)にも
    #    「どの文書の断片か」という文脈が意味検索に効くようにするため。
    #    DBに保存するcontentは本文のまま。タイトルを含めて保存すると、
    #    引用スニペットにタイトルが重複表示され、さらに全チャンクが
    #    タイトル語のILIKEにヒットしてキーワード検索が洪水を起こす
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT title FROM "Manual" WHERE id = %s',
                (str(req.manual_id),),
            )
            row = cur.fetchone()
    # タイトルもNFCに揃えてから埋め込みに使う(移行前のNFDデータへの保険)
    title = normalize_text(row[0]) if row else ""
    embeddings = embedder.embed_texts(
        [f"{title}\n{content}" if title else content for content, _page in chunks]
    )

    # 5) チャンクをDBへ保存(再取り込みに備え、同じマニュアルの既存チャンクは入れ替え)
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'DELETE FROM "ManualChunk" WHERE manual_id = %s',
                (str(req.manual_id),),
            )
            for i, ((content, page_no), emb) in enumerate(zip(chunks, embeddings)):
                cur.execute(
                    f'INSERT INTO "ManualChunk" (id, manual_id, chunk_index, page_number, content, {EMBEDDING_COLUMN}) '
                    "VALUES (gen_random_uuid(), %s, %s, %s, %s, %s::vector)",
                    (str(req.manual_id), i, page_no, content, to_vector_literal(emb)),
                )

    return IngestResponse(
        manual_id=str(req.manual_id),
        page_count=len(pages),
        chunk_count=len(chunks),
        transcribed_page_count=transcribed_count,
        pdf_created_at=pdf_created_at,
    )


class OrganizeItem(BaseModel):
    manual_id: str
    title: str
    snippet: str


class OrganizeRequest(BaseModel):
    manuals: list[OrganizeItem]
    categories: list[str]  # 既存カテゴリ名
    # falseなら既存カテゴリだけに割り当てる(勝手に増やしたくない場合)
    allow_new: bool = True
    # 管理者が指定した分類方針(例:「工種ごとに」)。チャット経由の再分類で使う
    instruction: str | None = None
    # 管理者が蓄積した分類ルール(最優先で適用)
    rules: list[str] = []


class OrganizeAssignment(BaseModel):
    manual_id: str
    # 行き先。ルールが競合して決められなかった場合はNone(candidatesに候補が入る)
    category: str | None = None
    # 管理者のルールが食い違ったときの候補。どれにするかは利用者が選ぶ
    candidates: list[str] = []


class OrganizeResponse(BaseModel):
    assignments: list[OrganizeAssignment]


class ClusterQuestionsRequest(BaseModel):
    """質問文の一覧。IDは付けず、本文だけを渡す(誰の質問かは送らない)"""

    questions: list[str]


class QuestionTheme(BaseModel):
    theme: str  # まとめた見出し(例:「顛末書の書き方」)
    count: int  # このテーマに属する質問の件数
    examples: list[str] = []  # 代表的な質問文(最大3件)


class ClusterQuestionsResponse(BaseModel):
    themes: list[QuestionTheme]


@app.post(
    "/cluster-questions",
    response_model=ClusterQuestionsResponse,
    dependencies=[Depends(require_api_token)],
)
def cluster_questions(req: ClusterQuestionsRequest) -> ClusterQuestionsResponse:
    """質問文を意味の近さでテーマごとにまとめる(件数の多い順)。

    語尾違いの同じ質問がバラバラに数えられるのを防ぐためのもので、
    DBには一切書き込まない(判断だけを返す)。
    """
    questions = [q.strip() for q in req.questions if q.strip()]
    if not questions:
        return ClusterQuestionsResponse(themes=[])
    try:
        raw = answer_generator.cluster_questions(questions)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"集計に失敗しました: {e}")

    themes = [
        QuestionTheme(
            theme=str(t.get("theme", "")).strip(),
            count=int(t.get("count", 0)),
            examples=[str(x) for x in (t.get("examples") or [])][:3],
        )
        for t in raw
        if str(t.get("theme", "")).strip()
    ]
    themes.sort(key=lambda t: t.count, reverse=True)
    return ClusterQuestionsResponse(themes=themes)


@app.post("/organize", response_model=OrganizeResponse, dependencies=[Depends(require_api_token)])
def organize(req: OrganizeRequest) -> OrganizeResponse:
    """マニュアル一覧をAIでカテゴリ分けする(DBへの書き込みは行わない=判断だけ返す)"""
    if not req.manuals:
        return OrganizeResponse(assignments=[])
    try:
        raw = answer_generator.classify_manuals(
            [m.model_dump() for m in req.manuals],
            req.categories,
            allow_new=req.allow_new,
            instruction=req.instruction,
            rules=req.rules,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"分類に失敗しました: {e}")

    valid_ids = {m.manual_id for m in req.manuals}
    assignments = []
    for a in raw:
        if a.get("manual_id") not in valid_ids:
            continue
        category = str(a.get("category") or "").strip()
        # ルールが食い違ったときは候補だけが返る。行き先は利用者に選んでもらう
        candidates = [
            str(c).strip() for c in (a.get("candidates") or []) if str(c).strip()
        ]
        if not category and len(candidates) < 2:
            continue  # 行き先も候補も無いものは扱えない
        assignments.append(
            OrganizeAssignment(
                manual_id=a["manual_id"],
                category=category or None,
                candidates=candidates if not category else [],
            )
        )
    return OrganizeResponse(assignments=assignments)


# 1回の質問に添えられる画像の枚数。多いほど読み取りにも回答にも時間がかかるので、
# 「操作の前後」「エラー画面と設定画面」を並べられる程度に抑える
MAX_QUESTION_IMAGES = 4


def decode_images(req: SearchRequest) -> list[tuple[bytes, str]]:
    """リクエストの添付画像を (バイト列, 形式) の一覧にする"""
    items = list(req.images)
    # 1枚だけ渡していた頃の呼び出し方にも合わせる
    if not items and req.image_base64:
        items = [QuestionImage(base64=req.image_base64, format=req.image_format or "jpeg")]
    if len(items) > MAX_QUESTION_IMAGES:
        raise HTTPException(
            status_code=400, detail=f"画像は{MAX_QUESTION_IMAGES}枚までです"
        )

    decoded: list[tuple[bytes, str]] = []
    for item in items:
        image_format = (item.format or "jpeg").lower()
        if image_format not in ALLOWED_IMAGE_FORMATS:
            raise HTTPException(status_code=400, detail=f"未対応の画像形式です: {image_format}")
        try:
            image_bytes = base64.b64decode(item.base64)
        except Exception:
            raise HTTPException(status_code=400, detail="画像データを読み取れません")
        decoded.append((image_bytes, image_format))
    return decoded


def retrieve(req: SearchRequest):
    """質問から抜粋を集めるところまで(回答の生成は含まない)。

    /search と /search-stream で同じ検索をするために切り出してある。
    戻り値は (rows, images)。検索対象が1件も無い場合は rows が空になる。

    <=> はpgvectorのコサイン距離演算子。小さいほど「近い(似ている)」。
    """
    # 0) 質問を「同義語込みの検索キーワード列」に展開する(クエリ拡張)。
    #    質問者とマニュアルの語彙のずれを吸収し、会話の続き(「2です」等)は文脈も織り込む
    retrieval_query = req.question
    try:
        retrieval_query = answer_generator.rewrite_query(req.question, req.history)
    except Exception:
        pass  # 展開に失敗しても元の質問文で検索は続行する

    # 0.5) 添付画像があればデコードし、検索に使える説明文をClaudeに作らせる。
    #    「この画面どうすれば？」のような質問文だけでは検索できないため。
    #    prepare_images はここで1度だけ縮める(提供元ごとの判断で、Bedrock は素通し)。
    #    縮めた画像をそのまま返し、search()/search_stream() が generate に渡すので、
    #    説明用と回答用で同じ縮小が2回走らない
    images = answer_generator.prepare_images(decode_images(req))
    if images:
        description = ""
        try:
            description = transcriber.describe(images)
        except Exception as e:
            # WorkersAiTranscriber.describe は自分で空文字に倒すが、切り替え日まで
            # 本番の BedrockTranscriber.describe は AWS の4xx/5xxをそのまま上げる。
            # ここで受けないと、画像を添えた質問がまるごと HTTP 500 になる。
            # 説明文は検索語を増やすための味付けなので、無ければ質問文だけで続ける
            logger.warning("添付画像の説明に失敗しました(画像なしで検索します): %s", e)
        if description:
            retrieval_query = f"{retrieval_query}\n{description}"

    # 0.7) 表記ゆれをNFCに揃える。macOS由来のNFD(濁点・半濁点が結合文字)が
    #      混ざると、DB側(NFCで保存)との部分一致・ベクトル化が微妙にずれる
    retrieval_query = normalize_text(retrieval_query)

    # 1) 質問文(+画像の説明)を、チャンクと同じ方法でベクトル化
    query_vec = to_vector_literal(embedder.embed_texts([retrieval_query])[0])

    # 2) ハイブリッド検索: ベクトル(意味) + キーワード一致(数字や固有名詞に強い)
    terms = [t for t in re.split(r"\s+", retrieval_query) if len(t) >= 2][:10]
    with db_connect() as conn:
        with conn.cursor() as cur:
            # 鍵付きフォルダの中身は、管理者の質問でも根拠にしない
            rows = hybrid_search(cur, query_vec, terms)

    return rows, images


# 検索対象が1件も無いときの文面(管理者以外)。
# 「答えられなかった」ではなく「そもそも探す先が無い」ので集計対象にしない
NO_MANUALS_ANSWER = (
    "まだ検索できるマニュアルがありません。マニュアルをアップロードして取り込んでください。"
)


@app.post("/search", response_model=SearchResponse, dependencies=[Depends(require_api_token)])
def search(req: SearchRequest) -> SearchResponse:
    """質問に近い抜粋を集め、それを根拠にClaudeが回答を生成する(一括で返す)"""
    rows, images = retrieve(req)

    # 検索ヒットゼロでも、管理者のときは生成まで進める。
    # 管理操作(フォルダ作成など)はマニュアルが1件も無い状態でも成立する必要がある
    if not rows and not req.is_admin:
        return SearchResponse(
            answer=NO_MANUALS_ANSWER,
            citations=[],
            answered=None,
            outcome=OUTCOME_NO_MANUALS,
        )

    # 3) 取得した抜粋を根拠として、Claudeに回答文を書かせる。
    #    抜粋の見出しにページ番号を含めるので、回答文でも「(p.3)」のように言及できる。
    #    生成に失敗しても検索結果(引用)だけは返す(全滅させない)
    contexts = [
        Context(
            title=f"{title}(p.{page})" if page else title,
            content=content,
        )
        for _manual_id, title, content, page in rows
    ]
    options: list[str] = []
    actions: list[ActionRequest] = []
    used_rows = rows[:3]  # 保険の既定値: 参照の申告が無ければ上位3件だけ引用に出す
    answered: bool | None = None
    outcome: str | None = None
    try:
        raw_answer, raw_actions = answer_generator.generate(
            req.question,
            contexts,
            images=images,
            history=req.history,
            # 管理者にだけフォルダ作成・再分類のツールを渡す(実行はNestJS側)。
            # 一般ユーザーには「管理者専用の操作」と案内させるための補足を付ける
            tools=ADMIN_TOOLS if req.is_admin else None,
            is_admin=req.is_admin,
        )
        actions = [ActionRequest(**a) for a in raw_actions]
        # 本文もツール呼び出しも無い応答は失敗として扱う(空の吹き出しを出さない)
        if not raw_answer.strip() and not actions:
            raise ValueError("モデルが本文を返しませんでした")
        # 絞り込み質問の場合、[選択肢]行を本文から分離してボタン用データにする
        answer, options = extract_options(raw_answer)
        # [参照]行から「実際に根拠に使った抜粋」を特定し、引用をそこに絞る
        answer, used = extract_references(answer, len(rows))
        if used is not None:
            # 申告が無い場合は保険で上位3件を引用に出す(根拠にしたかは不明)
            used_rows = [rows[i] for i in used]
        outcome, answered = decide_outcome(actions, used, options)
        # 管理操作の要求時は、検索抜粋はほぼ無関係なので引用を出さない
        if actions:
            used_rows = []
    except Exception as e:
        answer = (
            "関連しそうなマニュアルが見つかりましたが、"
            f"回答文の生成に失敗しました({e})。以下の抜粋をご確認ください。"
        )
        # 「失敗した」と伝えた応答から管理操作が実行されるのを防ぐ
        actions = []
        options = []
        # 生成に失敗しただけで、マニュアルの有無とは無関係
        answered = None
        outcome = OUTCOME_FAILED

    # 引用は「実際に使われた抜粋」だけを、同じマニュアルの同じページでまとめて返す
    citations: list[Citation] = []
    seen: set[tuple[str, int | None]] = set()
    for manual_id, title, content, page in used_rows:
        if (manual_id, page) in seen:
            continue
        seen.add((manual_id, page))
        citations.append(
            Citation(manual_id=manual_id, title=title, snippet=content[:150], page=page)
        )

    return SearchResponse(
        answer=answer,
        citations=citations,
        options=options,
        actions=actions,
        answered=answered,
        outcome=outcome,
    )


class DraftManualRequest(BaseModel):
    question: str


class DraftSource(BaseModel):
    """下書きの材料にした既存マニュアル"""

    manual_id: str
    title: str
    page: int | None = None


class DraftManualResponse(BaseModel):
    draft: str  # Markdown
    sources: list[DraftSource] = []


@app.post(
    "/draft-manual",
    response_model=DraftManualResponse,
    dependencies=[Depends(require_api_token)],
)
def draft_manual(req: DraftManualRequest) -> DraftManualResponse:
    """答えられなかった質問から、マニュアルの下書きを作る。

    既存の抜粋を材料に渡すのは、書きぶりや用語を既存のマニュアルに
    寄せるためと、「実は近いことが書いてある資料」を担当者に示すため。
    DBには書き込まない(下書きを返すだけ)。
    """
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="質問が空です")

    # 材料集めは通常の検索と同じ(鍵付きフォルダは含まない。下書きは全員が読む
    # マニュアルになるので、隠している資料の記述が混ざってはいけない)
    query = normalize_text(question)
    try:
        query_vec = to_vector_literal(embedder.embed_texts([query])[0])
        terms = [t for t in re.split(r"\s+", query) if len(t) >= 2][:10]
        with db_connect() as conn:
            with conn.cursor() as cur:
                rows = hybrid_search(cur, query_vec, terms)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"関連資料を探せませんでした: {e}")

    contexts = [
        Context(title=f"{title}(p.{page})" if page else title, content=content)
        for _manual_id, title, content, page in rows
    ]
    try:
        draft = answer_generator.draft_manual(question, contexts)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"下書きを作れませんでした: {e}")

    # 材料にした資料は、同じマニュアルのページをまとめて返す
    sources: list[DraftSource] = []
    seen: set[tuple[str, int | None]] = set()
    for manual_id, title, _content, page in rows:
        if (manual_id, page) in seen:
            continue
        seen.add((manual_id, page))
        sources.append(DraftSource(manual_id=manual_id, title=title, page=page))

    return DraftManualResponse(draft=draft, sources=sources)


class ReembedRequest(BaseModel):
    manual_id: UUID4


class ReembedResponse(BaseModel):
    chunk_count: int


@app.post(
    "/reembed-title",
    response_model=ReembedResponse,
    dependencies=[Depends(require_api_token)],
)
def reembed_title(req: ReembedRequest) -> ReembedResponse:
    """タイトルだけが変わったときに、ベクトルを作り直す。

    ベクトルは取り込み時に「タイトル\n本文」で作っている(本文に手がかりが
    無いチャンクにも、どの文書の断片かという文脈を持たせるため)。
    そのため名前を変えると、意味検索だけが古い名前のままになる。
    本文は変わっていないのでPDFの読み直しは不要で、埋め込みだけを作り直す。
    """
    manual_id = str(req.manual_id)
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT title FROM "Manual" WHERE id = %s', (manual_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="マニュアルが見つかりません")
            title = normalize_text(row[0] or "")
            cur.execute(
                'SELECT id, content FROM "ManualChunk" WHERE manual_id = %s '
                "ORDER BY chunk_index",
                (manual_id,),
            )
            chunks = cur.fetchall()

    if not chunks:
        return ReembedResponse(chunk_count=0)

    embeddings = embedder.embed_texts(
        [f"{title}\n{content}" if title else content for _id, content in chunks]
    )
    with db_connect() as conn:
        with conn.cursor() as cur:
            for (chunk_id, _content), emb in zip(chunks, embeddings):
                cur.execute(
                    f'UPDATE "ManualChunk" SET {EMBEDDING_COLUMN} = %s::vector WHERE id = %s',
                    (to_vector_literal(emb), chunk_id),
                )
        conn.commit()
    return ReembedResponse(chunk_count=len(chunks))


# --- ストリーミング(回答を少しずつ返す) ---

# 末尾に付く制御行。途中経過として画面に出さないよう、行単位で伏せる
CONTROL_LINE = re.compile(r"^\s*(\[参照\]|\[選択肢\]|選択肢[：:])")


class StreamBuffer:
    """流れてくる文字から、画面に出してよい分だけを取り出す。

    [参照]・[選択肢]の行は本文から除去される決まりなので、行が完成するまで
    出さずに持っておき、制御行だと分かったら捨てる。行の途中で切って出すと
    「[参照] 1,3」が一瞬見えてしまう
    """

    def __init__(self) -> None:
        self._pending = ""
        # 制御行が現れたら、そこから先はすべて本文ではない。
        # 1行だけ捨てる作りにすると、選択肢が複数行に分かれたときに
        # 2行目以降が本文として漏れる
        self._stopped = False

    def push(self, text: str) -> str:
        """追加された文字を受け取り、画面に出してよい分を返す"""
        if self._stopped:
            return ""
        self._pending += text
        out = []
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            if CONTROL_LINE.match(line):
                self._stopped = True
                self._pending = ""
                return "".join(out)
            out.append(line + "\n")
        # 行の途中でも、制御行になりそうな書き出しでなければ出してよい
        if self._pending and not self._pending.lstrip().startswith(("[", "選択肢")):
            out.append(self._pending)
            self._pending = ""
        return "".join(out)


def sse(event: str, data: dict) -> str:
    """Server-Sent Events の1件分。改行2つで1件の区切り"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/search-stream", dependencies=[Depends(require_api_token)])
def search_stream(req: SearchRequest):
    """/search と同じ回答を、文字が生成されるそばから返す。

    形式はSSE。イベントは delta(追加された文字) → done(確定した全文と引用)。
    途中で失敗した場合は error を1件返して終わる。
    """

    def events():
        # 最初の1バイトを早く送る。CloudFrontとALBは無通信60秒で切るため、
        # 検索に時間がかかっても接続が保たれるようにする
        yield sse("start", {})
        try:
            rows, images = retrieve(req)
        except HTTPException as e:
            yield sse("error", {"message": str(e.detail)})
            return
        except Exception as e:
            yield sse("error", {"message": f"検索に失敗しました: {e}"})
            return

        if not rows and not req.is_admin:
            yield sse("delta", {"text": NO_MANUALS_ANSWER})
            yield sse(
                "done",
                {
                    "answer": NO_MANUALS_ANSWER,
                    "citations": [],
                    "options": [],
                    "actions": [],
                    "answered": None,
                    "outcome": OUTCOME_NO_MANUALS,
                },
            )
            return

        contexts = [
            Context(title=f"{title}(p.{page})" if page else title, content=content)
            for _manual_id, title, content, page in rows
        ]
        used_rows = rows[:3]  # 保険の既定値: 参照の申告が無ければ上位3件
        answered: bool | None = None
        outcome: str | None = None
        options: list[str] = []
        actions: list[ActionRequest] = []
        buffer = StreamBuffer()
        raw_answer = ""

        try:
            for chunk in answer_generator.generate_stream(
                req.question,
                contexts,
                images=images,
                history=req.history,
                tools=ADMIN_TOOLS if req.is_admin else None,
                is_admin=req.is_admin,
            ):
                if chunk["type"] == "delta":
                    visible = buffer.push(chunk["text"])
                    if visible:
                        yield sse("delta", {"text": visible})
                elif chunk["type"] == "tool":
                    # 管理操作は実行結果で本文が差し替わるので、途中経過を消す
                    yield sse("reset", {})
                elif chunk["type"] == "done":
                    raw_answer = chunk["answer"]
                    actions = [ActionRequest(**a) for a in chunk["actions"]]

            if not raw_answer.strip() and not actions:
                raise ValueError("モデルが本文を返しませんでした")

            answer, options = extract_options(raw_answer)
            answer, used = extract_references(answer, len(rows))
            if used is not None:
                used_rows = [rows[i] for i in used]
            outcome, answered = decide_outcome(actions, used, options)
            if actions:
                used_rows = []
        except Exception as e:
            answer = (
                "関連しそうなマニュアルが見つかりましたが、"
                f"回答文の生成に失敗しました({e})。以下の抜粋をご確認ください。"
            )
            actions = []
            options = []
            answered = None
            outcome = OUTCOME_FAILED
            yield sse("reset", {})

        citations: list[dict] = []
        seen: set[tuple[str, int | None]] = set()
        for manual_id, title, content, page in used_rows:
            if (manual_id, page) in seen:
                continue
            seen.add((manual_id, page))
            citations.append(
                {
                    "manual_id": manual_id,
                    "title": title,
                    "snippet": content[:150],
                    "page": page,
                }
            )

        # 確定した全文を必ず送る。伏せていた分や制御行の除去をここで合わせる
        yield sse(
            "done",
            {
                "answer": answer,
                "citations": citations,
                "options": options,
                "actions": [a.model_dump() for a in actions],
                "answered": answered,
                "outcome": outcome,
            },
        )

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            # 途中で溜め込ませないための指定(プロキシ・CloudFront対策)
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
