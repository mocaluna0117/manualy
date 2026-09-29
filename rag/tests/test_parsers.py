"""LLMの出力を解析する部分のテスト。

ここはプロンプトを1行触るだけで静かに壊れる場所なので、
実際にClaudeが返してきた形をそのまま固定しておく。
- 選択肢が抽出できないとボタンが出ず、対話で絞り込めなくなる
- [参照]の解釈がずれると引用(マニュアルへのリンク)が消える／間違ったものを指す
"""

import os
import sys

# rag/ をimportパスに入れる(テストはrag/tests配下に置く)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://dummy/dummy")

from chunking import split_text  # noqa: E402
from main import extract_options, extract_references  # noqa: E402


class TestExtractOptions:
    """絞り込み選択肢の抽出(ボタン表示のもと)"""

    def test_正規の形式を抽出できる(self):
        answer = "どちらの状況ですか？\n\n[選択肢] お客様に断りメールを書きたい\n[選択肢] 社内で相談したい"
        body, options = extract_options(answer)
        assert options == ["お客様に断りメールを書きたい", "社内で相談したい"]
        assert "[選択肢]" not in body
        assert body == "どちらの状況ですか？"

    def test_形式を守らない出力も救済する(self):
        """モデルが指示を無視して番号列挙してきた場合(実際に起きたケース)"""
        answer = (
            "**ステップ4：報告書を添付保存する（p.14）**\n\n"
            "- チェックをクリックして保存\n\n"
            "**次に知りたくなりそうなこと：** 選択肢: 1. 是正ありの場合の詳しい手順を知りたい"
            " / 2. HPC入力の手順を知りたい / 3. 進捗管理表の更新方法を知りたい"
        )
        body, options = extract_options(answer)
        assert options == [
            "是正ありの場合の詳しい手順を知りたい",
            "HPC入力の手順を知りたい",
            "進捗管理表の更新方法を知りたい",
        ]
        # 見出しごと本文から除去されていること(画面に生テキストが残らない)
        assert "選択肢" not in body
        assert "次に知りたくなりそうなこと" not in body

    def test_本文中の言及では誤爆しない(self):
        """「選択肢」という単語が本文に出てくるだけのケースをボタン化しない"""
        answer = "選択肢: を提示する機能の使い方はマニュアルp.3を参照してください。" + "あ" * 500
        body, options = extract_options(answer)
        assert options == []
        assert body == answer

    def test_選択肢が無い回答はそのまま返る(self):
        answer = "フリーダイヤルの番号は 0800-170-6270 です。"
        body, options = extract_options(answer)
        assert options == []
        assert body == answer

    def test_1つだけの列挙はボタン化しない(self):
        """選択肢が1つだけなら絞り込みの意味がないので採用しない"""
        answer = "本文です。\n\n選択肢: 1. これだけ"
        _body, options = extract_options(answer)
        assert options == []


class TestExtractReferences:
    """[参照]行の解釈(引用として表示するマニュアルの決定)"""

    def test_使った抜粋番号を0始まりに変換する(self):
        body, used = extract_references("回答本文です。\n\n[参照] 1,3", total=8)
        assert used == [0, 2]
        assert body == "回答本文です。"

    def test_なしの申告は空リスト(self):
        """「該当マニュアルなし」の回答で引用を出さないため、Noneと区別する"""
        _body, used = extract_references("該当する記載はありません。\n\n[参照] なし", total=8)
        assert used == []

    def test_申告が無い場合はNone(self):
        """Noneのときは呼び出し側が上位3件にフォールバックする"""
        _body, used = extract_references("本文だけ", total=8)
        assert used is None

    def test_範囲外の番号は無視する(self):
        """存在しない抜粋番号を指されても間違ったマニュアルを引用しない"""
        _body, used = extract_references("x\n[参照] 2, 99, 0", total=8)
        assert used == [1]

    def test_参照行は本文から除去される(self):
        body, _used = extract_references("回答\n[参照] 1\n", total=3)
        assert "[参照]" not in body


class TestSplitText:
    """チャンク分割(検索の最小単位を作る)"""

    def test_重複ありで分割される(self):
        """2000字を800字/重複200字で割ると、600字ずつ進んで3チャンクになる"""
        text = "".join(str(i % 10) for i in range(2000))  # 位置が分かる文字列
        chunks = split_text(text, chunk_size=800, overlap=200)

        assert len(chunks) == 3
        assert all(len(c) <= 800 for c in chunks)
        # 隣り合うチャンクがoverlap分だけ重なっている(取りこぼし防止の本質)
        for prev, nxt in zip(chunks, chunks[1:]):
            assert prev[-200:] == nxt[:200]
        # 全体が漏れなく覆われている
        assert chunks[0][0] == text[0]
        assert chunks[-1][-1] == text[-1]

    def test_境界の文が隣のチャンクにも残る(self):
        """overlapの目的。境界で文が切れても検索で取りこぼさないため"""
        text = "先頭" + "x" * 700 + "境界のキーワード" + "y" * 700
        chunks = split_text(text, chunk_size=800, overlap=200)
        hit = [c for c in chunks if "境界のキーワード" in c]
        assert len(hit) >= 1

    def test_短い文はそのまま1つ(self):
        assert split_text("短い本文") == ["短い本文"]

    def test_空文字は空リスト(self):
        """空ページを取り込んでも空チャンクを作らない"""
        assert split_text("") == []
        assert split_text("   \n  ") == []

    def test_overlapがchunk_size以上なら例外(self):
        """無限ループを防ぐガード"""
        import pytest

        with pytest.raises(ValueError):
            split_text("あ" * 100, chunk_size=100, overlap=100)
