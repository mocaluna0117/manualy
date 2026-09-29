"""RAGサービスの入口を守る仕組み。

このサービスはDBを直接書き換えられる(取り込みでチャンクを差し替える)ため、
Dockerネットワーク内からしか届かない前提だけに頼らず、多重に防御する。

1) 共有トークンによる認証 … 呼び出せるのはbackendだけにする
2) ダウンロードURLの検証 … file:// や社内ホスト・メタデータエンドポイントを
   読み出させられる(SSRF)のを防ぐ
"""

import ipaddress
import logging
import os
import socket
from urllib.parse import urlparse

from fastapi import Header, HTTPException

logger = logging.getLogger("uvicorn.error")

# ダウンロードを許可するホスト。カンマ区切り(例: "minio,s3.ap-northeast-1.amazonaws.com")
# 未設定なら「ホストは制限しないが、スキームとIP種別の検証は行う」
ALLOWED_DOWNLOAD_HOSTS = [
    h.strip()
    for h in os.environ.get("RAG_ALLOWED_DOWNLOAD_HOSTS", "").split(",")
    if h.strip()
]

# 取り込むファイルのサイズ上限(メモリ枯渇と巨大ファイルによる詰まりを防ぐ)
MAX_DOWNLOAD_BYTES = int(os.environ.get("RAG_MAX_DOWNLOAD_BYTES", 100 * 1024 * 1024))

# ダウンロードのタイムアウト(秒)
DOWNLOAD_TIMEOUT = int(os.environ.get("RAG_DOWNLOAD_TIMEOUT", 60))


def require_api_token(x_api_token: str | None = Header(default=None)) -> None:
    """共有トークンを検証するFastAPIの依存。

    RAG_API_TOKENが未設定のときは全て拒否する(fail closed)。
    「設定を忘れたら誰でも叩ける」状態を作らないため、あえて通さない。
    """
    expected = os.environ.get("RAG_API_TOKEN")
    if not expected:
        logger.error(
            "RAG_API_TOKENが設定されていないため、APIリクエストを拒否しました。"
            "backendと同じトークンを環境変数に設定してください"
        )
        raise HTTPException(status_code=503, detail="サービスが未設定です")
    # 文字列比較のタイミング差から推測されないよう定数時間で比較する
    import hmac

    if not x_api_token or not hmac.compare_digest(x_api_token, expected):
        raise HTTPException(status_code=401, detail="認証が必要です")


def validate_download_url(url: str) -> None:
    """署名付きURLとして妥当かを検証する。問題があればHTTPExceptionを投げる。

    防ぎたいもの:
    - file:///etc/passwd のようなローカルファイル読み出し
    - http://169.254.169.254/... のクラウドメタデータ(認証情報の窃取)
    - 社内ネットワークの任意ホストへの到達(ポートスキャン・内部API叩き)
    """
    parsed = urlparse(url)

    # 1) スキームはhttp/httpsのみ(file, gopher, ftp などを弾く)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URLの形式が不正です")

    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=400, detail="URLの形式が不正です")

    # 2) ホストの許可リスト(設定されている場合)
    if ALLOWED_DOWNLOAD_HOSTS and host not in ALLOWED_DOWNLOAD_HOSTS:
        logger.warning("許可されていないホストへのダウンロード要求: %s", host)
        raise HTTPException(status_code=400, detail="URLの形式が不正です")

    # 3) 名前解決した先がリンクローカル(=メタデータ)やループバックでないか。
    #    許可リストに載っているホスト名でも、解決先が変わる攻撃(DNSリバインド)に備える。
    #    ただしDockerネットワーク内のプライベートIPは正常なので許容する
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="ダウンロード先に到達できません")

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_link_local or ip.is_multicast or ip.is_reserved:
            logger.warning("危険なIPへのダウンロード要求: %s -> %s", host, ip)
            raise HTTPException(status_code=400, detail="URLの形式が不正です")


def fetch_file(url: str) -> bytes:
    """検証済みURLからファイルを取得する(サイズ上限とタイムアウト付き)"""
    import urllib.request

    validate_download_url(url)
    try:
        with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT) as res:
            # Content-Lengthが分かる場合は読む前に弾く
            declared = res.headers.get("Content-Length")
            if declared and int(declared) > MAX_DOWNLOAD_BYTES:
                raise HTTPException(status_code=413, detail="ファイルが大きすぎます")
            # 上限+1だけ読んで超過を判定する(全部読んでから測るとメモリを食う)
            data = res.read(MAX_DOWNLOAD_BYTES + 1)
    except HTTPException:
        raise
    except Exception as e:
        # 例外の中身をそのまま返すと到達性や内部構成が漏れるのでログだけに残す
        logger.warning("ファイルの取得に失敗: %s", e)
        raise HTTPException(status_code=400, detail="ファイルを取得できませんでした")

    if len(data) > MAX_DOWNLOAD_BYTES:
        raise HTTPException(status_code=413, detail="ファイルが大きすぎます")
    return data
