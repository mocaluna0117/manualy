"""Supabaseへの接続で、相手の証明書を検証しないまま繋がないこと。

psycopg は sslrootcert を渡さないと sslmode 既定の prefer で繋ぐ。
暗号化はされても相手が本物かは確認しないので、盗聴には強くても
なりすましには無防備なまま「接続は普通に成功する」。
公衆網の向こうにある Supabase では、これに気づく手立てが無い。

AWS(RDS)とローカルの宛先は今までどおり繋がること(切り替え日まで本番)。
"""

import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://dummy/dummy")

import main  # noqa: E402

SUPABASE = (
    "postgresql://postgres.xscltxkkphwguetlcbkk:pw"
    "@aws-0-us-west-2.pooler.supabase.com:5432/postgres"
)
RDS = "postgresql://manual:pw@manual.abcdef.ap-northeast-1.rds.amazonaws.com:5432/manual_search"
LOCAL = "postgresql://manual:pw@localhost:54321/manual_search"


class TestNeedsSslCa:
    def test_Supabase宛にはCAが要る(self):
        assert main._needs_ssl_ca(SUPABASE) is True

    def test_接続文字列でCAを渡していれば要らない(self):
        # そちらで検証されるので二重に止める必要は無い
        assert main._needs_ssl_ca(f"{SUPABASE}?sslrootcert=/app/certs/supabase-ca.crt") is False

    def test_RDSは今までどおり(self):
        # 切り替え日まではこちらが本番。ここで止めるとAWS版が起動しなくなる
        assert main._needs_ssl_ca(RDS) is False

    def test_ローカルは今までどおり(self):
        assert main._needs_ssl_ca(LOCAL) is False


def reload_main_with(**env):
    """envを差し替えて main を読み直し、見たい値を控えて返す。

    importlib.reload は同じモジュールオブジェクトを書き換えるので、
    後片付けの読み直しをすると属性は元に戻る。だから戻り値は
    モジュールではなく、その場で控えた値の写しにする。
    """
    saved = {k: os.environ.get(k) for k in env}
    try:
        for key, value in env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        reloaded = importlib.reload(main)
        return {"_DB_SSL_ARGS": dict(reloaded._DB_SSL_ARGS)}
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        importlib.reload(main)  # 後続のテストのために健全な状態へ戻す


class TestStartupGuard:
    def test_CAが無いまま起動しない(self):
        # Cloud Run で DATABASE_SSL_CA の渡し忘れがあれば、黙って無検証で
        # 繋ぐのではなく起動しないことで気づける
        with pytest.raises(RuntimeError, match="DATABASE_SSL_CA"):
            reload_main_with(DATABASE_URL=SUPABASE, DATABASE_SSL_CA=None)

    def test_CAがあれば検証付きで繋ぐ(self):
        snapshot = reload_main_with(
            DATABASE_URL=SUPABASE, DATABASE_SSL_CA="/app/certs/supabase-ca.crt"
        )
        assert snapshot["_DB_SSL_ARGS"] == {
            "sslmode": "verify-full",
            "sslrootcert": "/app/certs/supabase-ca.crt",
        }

    def test_RDSはCAが無くても起動する(self):
        snapshot = reload_main_with(DATABASE_URL=RDS, DATABASE_SSL_CA=None)
        assert snapshot["_DB_SSL_ARGS"] == {}
