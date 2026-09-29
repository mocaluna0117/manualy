"""マウントした秘密のJSONを環境変数へ展開する部分のテスト。

ここが壊れる形は2つあり、どちらも静かに壊れる。
- 読み込みが遅れる … security.py は import 時に環境変数を読むので、
  後から入れても「RAG_API_TOKENが未設定」で全リクエストを拒否し続ける
- 上書きしてしまう … デプロイ時に指定した新しい値が、シークレットの
  古い値で黙って置き換わると原因を追えない
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from secrets_file import load  # noqa: E402


@pytest.fixture
def clean_env():
    """テストで触るキーを後片付けする"""
    keys = [
        "MANUALY_TEST_DB_URL",
        "MANUALY_TEST_TOKEN",
        "MANUALY_TEST_PORT",
        "MANUALY_TEST_FLAG",
        "MANUALY_TEST_NULL",
    ]
    for key in keys:
        os.environ.pop(key, None)
    yield
    for key in keys:
        os.environ.pop(key, None)


def write(tmp_path, content: str) -> str:
    path = tmp_path / "app.json"
    path.write_text(content, encoding="utf-8")
    return str(path)


def test_ファイルが無ければ何もしない(tmp_path):
    """ローカルとAWSは今までどおり環境変数だけで動く"""
    assert load(str(tmp_path / "存在しない.json")) == 0


def test_未設定の環境変数を埋める(tmp_path, clean_env):
    path = write(
        tmp_path,
        json.dumps({"MANUALY_TEST_DB_URL": "postgres://example", "MANUALY_TEST_TOKEN": "abc"}),
    )

    assert load(path) == 2
    assert os.environ["MANUALY_TEST_DB_URL"] == "postgres://example"
    assert os.environ["MANUALY_TEST_TOKEN"] == "abc"


def test_既に入っている値は上書きしない(tmp_path, clean_env):
    """デプロイ時に明示した値のほうが意図が新しい"""
    os.environ["MANUALY_TEST_DB_URL"] = "postgres://いま動いているほう"
    path = write(tmp_path, json.dumps({"MANUALY_TEST_DB_URL": "postgres://ふるいほう"}))

    assert load(path) == 0
    assert os.environ["MANUALY_TEST_DB_URL"] == "postgres://いま動いているほう"


def test_数値と真偽値は文字列にし_nullは飛ばす(tmp_path, clean_env):
    path = write(
        tmp_path,
        json.dumps(
            {
                "MANUALY_TEST_PORT": 8080,
                "MANUALY_TEST_FLAG": True,
                "MANUALY_TEST_NULL": None,
            }
        ),
    )

    assert load(path) == 2
    assert os.environ["MANUALY_TEST_PORT"] == "8080"
    # JSONと同じ小文字にする(Pythonの "True" だと設定値として扱いにくい)
    assert os.environ["MANUALY_TEST_FLAG"] == "true"
    assert "MANUALY_TEST_NULL" not in os.environ


def test_JSONが壊れていたら起動を止める(tmp_path):
    """半端な設定のまま動かさない。落ちれば気づける"""
    path = write(tmp_path, "{壊れている")

    with pytest.raises(RuntimeError, match="JSON"):
        load(path)


def test_トップレベルがオブジェクトでなければ起動を止める(tmp_path):
    path = write(tmp_path, json.dumps(["a", "b"]))

    with pytest.raises(RuntimeError, match="オブジェクト"):
        load(path)


def test_mainより先に読み込まれる():
    """security.py などが環境変数を読む前に走っていること。

    import順を入れ替えると静かに壊れる(security.pyがimport時に
    RAG_API_TOKENを読むため、後から入れても拒否し続ける)ので、
    main.py の中でどのプロジェクト内importより前にあることを固定する。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    source = open(os.path.join(os.path.dirname(here), "main.py"), encoding="utf-8").read()
    lines = [line for line in source.splitlines() if line.startswith(("import ", "from "))]
    assert lines[0].startswith("import secrets_file")
