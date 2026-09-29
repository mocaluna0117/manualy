"""Workers AI(gemma)の回答生成プロバイダのテスト。

ここは壊れても例外が出ず、静かに管理操作だけが効かなくなる場所なので、
「壊れたら止まる」ことを固定する。
- 思考を切り忘れると、そのメソッドだけmax_tokensを独り言で使い切って本文が空になる
- ストリームのtool_callsのindexは「tools配列でのそのツールの位置」なので、
  同じツールを2回呼ぶと同じindexで届く。indexで束ねると2件が1件に潰れる
- 同じツールの2回分の引数が1件の枠に連結されて届くことがある
- ツール解析が外れたモデルは、呼んだつもりで生の記法を本文に書く(glmで実測)
- 日次枠切れの429を再試行すると、回復しないものを待ち続けたうえで英文が画面に出る
"""

import json
import os
import sys
from types import SimpleNamespace

import pytest
from openai import BadRequestError, InternalServerError, RateLimitError

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import llm  # noqa: E402
from llm import (  # noqa: E402
    ADMIN_TOOLS,
    DAILY_QUOTA_MESSAGE,
    Context,
    WorkersAiAnswerGenerator,
    _to_openai_tools,
    create_answer_generator,
)


class FakeCompletions:
    """openai SDK の client.chat.completions を真似る。応答は make(kwargs) で作る"""

    def __init__(self, make):
        self.make = make
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.make(kwargs)


def fake_client(make):
    return SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions(make)))


def gen(make, model="m"):
    return WorkersAiAnswerGenerator(model=model, client=fake_client(make))


def tool_call(name: str, arguments):
    return SimpleNamespace(function=SimpleNamespace(name=name, arguments=arguments))


def reply(content=None, tool_calls=None, finish_reason="stop", **extra):
    """非ストリームの応答1件。extra は reasoning_content 等の想定外フィールド"""
    message = SimpleNamespace(
        content=content, tool_calls=tool_calls, model_extra=extra or {}, **extra
    )
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason=finish_reason)]
    )


def chunk(content=None, tool_calls=None, finish_reason=None, **extra):
    """ストリームの断片1つ"""
    delta = SimpleNamespace(content=content, tool_calls=tool_calls, **extra)
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)]
    )


def stream_tool(index: int, name=None, arguments=None, id=None):
    """ストリームのツール断片1つ。idが付くのは各呼び出しの最初の断片だけ"""
    return SimpleNamespace(
        index=index, id=id, function=SimpleNamespace(name=name, arguments=arguments)
    )


class RaisingCompletions:
    """先頭から順に errors を投げ、尽きたら make(kwargs) を返す"""

    def __init__(self, errors, make=None):
        self.errors = list(errors)
        self.make = make or (lambda kwargs: reply(content="本文"))
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.errors:
            raise self.errors.pop(0)
        return self.make(kwargs)


def raising_gen(errors, make=None):
    completions = RaisingCompletions(errors, make)
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return WorkersAiAnswerGenerator(model="m", client=client)


def api_error(cls, status: int, body=None):
    """openai SDK が投げてくるHTTPエラーを組み立てる。

    message に本文を並べるのは実物と同じ形にするため
    (SDKは 'Error code: 429 - {...}' という文字列にして投げてくる)。
    """
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


CTX = [Context("共通アフター対応マニュアル(p.4)", "床鳴りは施工店へ手配する。")]


class TestThinkingFlag:
    def test_全メソッドが思考を切るフラグを送る(self):
        # 1つでも付け忘れると、そのメソッドだけ独り言でmax_tokensを使い切って空を返す
        def make(kwargs):
            if kwargs.get("stream"):
                return iter([chunk(content="本文")])
            return reply(content='[{"manual_id": "m1", "category": "床"}]')

        g = gen(make)
        g.generate("q", CTX)
        list(g.generate_stream("q", CTX))
        g.rewrite_query("q", [])
        g.classify_manuals([{"manual_id": "m1", "title": "t", "snippet": "s"}], [])
        g.cluster_questions(["q1"])
        g.draft_manual("q", CTX)

        calls = g.client.chat.completions.calls
        assert len(calls) == 6
        for call in calls:
            assert call["extra_body"] == {
                "chat_template_kwargs": {"enable_thinking": False}
            }

    def test_tool_choiceは指定しない(self):
        # 'required' は400、名前指定はglmで引数が壊れた。既定のautoに任せる
        g = gen(lambda kwargs: reply(content="本文"))
        g.generate("q", CTX, tools=ADMIN_TOOLS, is_admin=True)
        assert "tool_choice" not in g.client.chat.completions.calls[0]


class TestToolConversion:
    def test_OpenAIのネスト形式になる(self):
        converted = _to_openai_tools(ADMIN_TOOLS)
        assert len(converted) == len(ADMIN_TOOLS)
        first = converted[0]
        assert first["type"] == "function"
        assert first["function"]["name"] == "create_folder"
        assert "parameters" in first["function"]
        assert "toolSpec" not in first

    def test_引数のdescriptionを落とさない(self):
        # admin_only の説明が落ちると、意図が無くても鍵付きフォルダを作り始める
        converted = _to_openai_tools(ADMIN_TOOLS)
        props = converted[0]["function"]["parameters"]["properties"]
        assert "鍵付き" in props["admin_only"]["description"]
        assert props["name"]["description"]

    def test_ADMIN_TOOLSを書き換えない(self):
        # この定数はBedrock版がそのまま使っている(構造を変えるとAWS版が壊れる)
        before = json.dumps(ADMIN_TOOLS, ensure_ascii=False, sort_keys=True)
        _to_openai_tools(ADMIN_TOOLS)
        assert json.dumps(ADMIN_TOOLS, ensure_ascii=False, sort_keys=True) == before

    def test_ツールが無ければtoolsを送らない(self):
        g = gen(lambda kwargs: reply(content="本文"))
        g.generate("q", CTX)
        assert "tools" not in g.client.chat.completions.calls[0]


class TestGenerate:
    def test_本文とツール呼び出しを分けて返す(self):
        g = gen(
            lambda kwargs: reply(
                content="フォルダを作成します。",
                tool_calls=[tool_call("create_folder", '{"name": "防水"}')],
                finish_reason="tool_calls",
            )
        )
        answer, actions = g.generate("q", CTX, tools=ADMIN_TOOLS, is_admin=True)
        assert answer == "フォルダを作成します。"
        assert actions == [{"name": "create_folder", "input": {"name": "防水"}}]

    def test_contentがNoneでも落ちない(self):
        # ツールだけを返した応答では content は空文字ではなく None で来る
        g = gen(
            lambda kwargs: reply(
                content=None,
                tool_calls=[tool_call("list_classification_rules", "")],
                finish_reason="tool_calls",
            )
        )
        answer, actions = g.generate("q", CTX, tools=ADMIN_TOOLS, is_admin=True)
        assert answer == ""
        # 引数の無いツールは空文字で来る。Noneではなくdictで返すこと(main.pyがdictを要求する)
        assert actions == [{"name": "list_classification_rules", "input": {}}]

    def test_二重エンコードされた引数もdictにする(self):
        # granite系はJSON文字列の中にもう一段JSONを入れて返す
        g = gen(
            lambda kwargs: reply(
                content="作ります",
                tool_calls=[tool_call("create_folder", json.dumps('{"name": "防水"}'))],
                finish_reason="tool_calls",
            )
        )
        _, actions = g.generate("q", CTX, tools=ADMIN_TOOLS, is_admin=True)
        assert actions == [{"name": "create_folder", "input": {"name": "防水"}}]

    def test_連結された引数を複数件に展開する(self):
        # 実機: 「防水関連と窓・ガラスのフォルダを作って」でエントリは1つ、
        # arguments が '{"name":"防水関連"}{"name":"窓・ガラス"}' と連結して届いた。
        # 例外にすると管理操作が1件も実行されないので、2件に分けて通す
        g = gen(
            lambda kwargs: reply(
                content="作ります",
                tool_calls=[
                    tool_call(
                        "create_folder", '{"name":"防水関連"}{"name":"窓・ガラス"}'
                    )
                ],
                finish_reason="tool_calls",
            )
        )
        _, actions = g.generate("q", CTX, tools=ADMIN_TOOLS, is_admin=True)
        assert actions == [
            {"name": "create_folder", "input": {"name": "防水関連"}},
            {"name": "create_folder", "input": {"name": "窓・ガラス"}},
        ]

    def test_解けない連結は例外にして1件ずつ指示を促す(self):
        # 分解できないものまで通すと、引数の抜けた操作が実行依頼として流れる。
        # 管理者が次の手を打てるように、文言で回避策まで伝える
        g = gen(
            lambda kwargs: reply(
                content="作ります",
                tool_calls=[tool_call("create_folder", '{"name":"防水"}{壊れ')],
                finish_reason="tool_calls",
            )
        )
        with pytest.raises(RuntimeError, match="1件ずつ指示してください"):
            g.generate("q", CTX, tools=ADMIN_TOOLS, is_admin=True)

    def test_壊れた引数は例外にする(self):
        # {}に握りつぶすと、名前の無いcreate_folderが実行依頼として流れてしまう
        g = gen(
            lambda kwargs: reply(
                content="作ります",
                tool_calls=[tool_call("create_folder", "{名前:")],
                finish_reason="tool_calls",
            )
        )
        with pytest.raises(RuntimeError, match="引数"):
            g.generate("q", CTX, tools=ADMIN_TOOLS, is_admin=True)

    def test_思考フィールドが混ざっても本文に入れない(self):
        g = gen(
            lambda kwargs: reply(
                content="床鳴りは施工店へ手配します。",
                reasoning_content="Okay, the user is asking about floor squeaks...",
            )
        )
        answer, _ = g.generate("q", CTX)
        assert answer == "床鳴りは施工店へ手配します。"
        assert "Okay" not in answer

    def test_ツール記法が本文に漏れたら例外にする(self):
        # glmで実測。tool_callsが空のまま生の記法が本文に出る。
        # 黙って通すと管理者の画面に<arg_key>が出て、実行されていない操作が
        # 実行されたように読める
        leaked = (
            "create_folder<arg_key>name</arg_key>"
            "<arg_value>防水</arg_value></tool_call>"
        )
        g = gen(lambda kwargs: reply(content=leaked, finish_reason="stop"))
        with pytest.raises(RuntimeError, match="ツール呼び出しを本文"):
            g.generate("q", CTX, tools=ADMIN_TOOLS, is_admin=True)

    def test_本文もツールも無ければ例外にする(self):
        g = gen(lambda kwargs: reply(content="", tool_calls=[]))
        with pytest.raises(RuntimeError, match="本文もツール"):
            g.generate("q", CTX)

    def test_抜粋に番号を振って渡す(self):
        # [参照]行の番号はこの並びを指す。ずれると引用が別の資料になる
        g = gen(lambda kwargs: reply(content="本文"))
        g.generate("床鳴りは?", [Context("A", "あ"), Context("B", "い")])
        sent = g.client.chat.completions.calls[0]["messages"][-1]["content"]
        assert "【抜粋1】A" in sent and "【抜粋2】B" in sent
        assert "# 質問\n床鳴りは?" in sent

    def test_管理者と一般で補足が変わる(self):
        g = gen(lambda kwargs: reply(content="本文"))
        g.generate("q", CTX, is_admin=True)
        g.generate("q", CTX, is_admin=False)
        admin, member = (
            c["messages"][0]["content"] for c in g.client.chat.completions.calls
        )
        assert "補足(管理者モード)" in admin
        assert "補足(権限について)" in member

    def test_履歴をそのまま前のターンとして渡す(self):
        g = gen(lambda kwargs: reply(content="本文"))
        history = [
            SimpleNamespace(role="user", content="床鳴り"),
            SimpleNamespace(role="assistant", content="[選択肢] 新築"),
        ]
        g.generate("1です", CTX, history=history)
        messages = g.client.chat.completions.calls[0]["messages"]
        assert messages[1] == {"role": "user", "content": "床鳴り"}
        assert messages[2] == {"role": "assistant", "content": "[選択肢] 新築"}

    def test_添付画像は縮めてから渡す(self):
        # スマホ写真を2枚添えるとボディ上限(base64で約6MB)を超えて400になる。
        # 書き起こし側と同じ vision.shrink_for_upload を必ず通すこと
        import vision

        original = vision.shrink_for_upload
        seen: list[list] = []

        def fake(images):
            seen.append(list(images))
            return [(b"shrunk", "jpeg")]

        vision.shrink_for_upload = fake
        try:
            g = gen(lambda kwargs: reply(content="本文"))
            g.generate("これは?", CTX, images=[(b"\x89PNG", "png")])
        finally:
            vision.shrink_for_upload = original
        assert seen == [[(b"\x89PNG", "png")]]
        content = g.client.chat.completions.calls[0]["messages"][-1]["content"]
        assert content[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")

    def test_画像はdataURIで渡す(self):
        g = gen(lambda kwargs: reply(content="本文"))
        g.generate("これは?", CTX, images=[(b"\x89PNG", "png")])
        content = g.client.chat.completions.calls[0]["messages"][-1]["content"]
        assert content[0]["type"] == "image_url"
        assert content[0]["image_url"]["url"].startswith("data:image/png;base64,")
        # 画像が添付されている旨をBedrock版と同じ文面で添える
        assert "画像が添付されています" in content[-1]["text"]


class TestGenerateStream:
    def test_断片を順に流して最後にdoneを1回返す(self):
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(content="床鳴りは"),
                    chunk(content="施工店へ。"),
                    chunk(finish_reason="stop"),
                    chunk(finish_reason="stop"),  # 終端は2回届く
                ]
            )
        )
        out = list(g.generate_stream("q", CTX))
        assert [o["type"] for o in out] == ["delta", "delta", "done"]
        assert out[-1] == {
            "type": "done",
            "answer": "床鳴りは施工店へ。",
            "actions": [],
        }

    def test_終端が2回来てもdoneは1回(self):
        # finish_reasonを合図にdoneを出すと、main.py側のactionsが二重になる
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(content="本文"),
                    chunk(finish_reason="stop"),
                    chunk(finish_reason="stop"),
                ]
            )
        )
        out = list(g.generate_stream("q", CTX))
        assert [o["type"] for o in out].count("done") == 1

    def test_indexが飛んでも依頼順に組み立てる(self):
        # 実測: 1つ目がindex=0、2つ目がindex=7で届いた。
        # listにappendすると2件目の引数が1件目に混ざる
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(tool_calls=[stream_tool(0, name="create_folder")]),
                    chunk(tool_calls=[stream_tool(0, arguments='{"name": "屋根"}')]),
                    chunk(tool_calls=[stream_tool(7, name="reclassify_all_manuals")]),
                    chunk(tool_calls=[stream_tool(7, arguments="{}")]),
                    chunk(finish_reason="tool_calls"),
                ]
            )
        )
        out = list(g.generate_stream("q", CTX, tools=ADMIN_TOOLS, is_admin=True))
        assert out[-1]["actions"] == [
            {"name": "create_folder", "input": {"name": "屋根"}},
            {"name": "reclassify_all_manuals", "input": {}},
        ]

    def test_同じindexでもidが変われば別の呼び出しにする(self):
        # 実機の生ダンプ: indexは呼び出しの通し番号ではなく
        # 「tools配列の中でのそのツールの位置」で、同じツールを2回呼ぶと
        # どちらも同じindexで届く(add_classification_rule は常に4)。
        # 新しい呼び出しの合図は非nullのid。indexで束ねると2件が1枠に潰れ、
        # 引数が '{"text":"…"}{"text":"…"}' と連結されて解釈に失敗した
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(
                        tool_calls=[
                            stream_tool(
                                4,
                                id="call_4e94",
                                name="add_classification_rule",
                                arguments="",
                            )
                        ]
                    ),
                    chunk(
                        tool_calls=[
                            stream_tool(4, arguments='{"text":"顛末書は書類カテゴリへ"}')
                        ]
                    ),
                    chunk(
                        tool_calls=[
                            stream_tool(
                                4,
                                id="call_9f56",
                                name="add_classification_rule",
                                arguments="",
                            )
                        ]
                    ),
                    chunk(
                        tool_calls=[
                            stream_tool(4, arguments='{"text":"防水は水回りへ"}')
                        ]
                    ),
                    chunk(finish_reason="tool_calls"),
                ]
            )
        )
        out = list(g.generate_stream("q", CTX, tools=ADMIN_TOOLS, is_admin=True))
        assert out[-1]["actions"] == [
            {
                "name": "add_classification_rule",
                "input": {"text": "顛末書は書類カテゴリへ"},
            },
            {"name": "add_classification_rule", "input": {"text": "防水は水回りへ"}},
        ]

    def test_同じindexの2件目にnameが無くても捨てない(self):
        # 実測の生ダンプ: 2件目の呼び出しは新しい id を持つのに name が載らず、
        # 引数だけで届くことがある。id をキーにしたあと name 空の枠を
        # 「名前が分からないもの」として飛ばしていたので、2件目が黙って消えていた
        # (index で束ねていた頃は同じ枠に入るので2件とも取れていた)。
        # 消えると管理者には「実行しました」に見えるのに1件しか作られない
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(
                        tool_calls=[
                            stream_tool(
                                4,
                                id="call_a",
                                name="add_classification_rule",
                                arguments='{"text":"A"}',
                            )
                        ]
                    ),
                    chunk(
                        tool_calls=[
                            stream_tool(4, id="call_b", arguments='{"text":"B"}')
                        ]
                    ),
                    chunk(finish_reason="tool_calls"),
                ]
            )
        )
        out = list(g.generate_stream("q", CTX, tools=ADMIN_TOOLS, is_admin=True))
        assert out[-1]["actions"] == [
            {"name": "add_classification_rule", "input": {"text": "A"}},
            {"name": "add_classification_rule", "input": {"text": "B"}},
        ]

    def test_引き継ぐ相手がいなければ例外にする(self):
        # 同じ index に前の枠が無い(=1件目から name が載っていない)ときは
        # 何のツールか決めようがない。黙って捨てると「依頼したのに実行されず、
        # 失敗したとも言われない」ので、例外にして main.py に失敗として出させる
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(
                        tool_calls=[
                            stream_tool(2, id="call_x", arguments='{"name":"防水"}')
                        ]
                    ),
                    chunk(finish_reason="tool_calls"),
                ]
            )
        )
        with pytest.raises(RuntimeError, match="ツール呼び出しの名前"):
            list(g.generate_stream("q", CTX, tools=ADMIN_TOOLS, is_admin=True))

    def test_別のindexからは引き継がない(self):
        # 引き継ぐのは「同じ index の直前の枠」だけ。別のツールの名前を
        # 借りてしまうと、頼んでいない操作を実行することになる
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(
                        tool_calls=[
                            stream_tool(0, id="call_a", name="create_folder")
                        ]
                    ),
                    chunk(
                        tool_calls=[
                            stream_tool(4, id="call_b", arguments='{"text":"A"}')
                        ]
                    ),
                    chunk(finish_reason="tool_calls"),
                ]
            )
        )
        with pytest.raises(RuntimeError, match="ツール呼び出しの名前"):
            list(g.generate_stream("q", CTX, tools=ADMIN_TOOLS, is_admin=True))

    def test_連結された引数はストリームでも複数件に展開する(self):
        # 1つの呼び出し(id は1つ)に2件分の引数が入って届く場合
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(
                        tool_calls=[
                            stream_tool(0, id="call_6667", name="create_folder")
                        ]
                    ),
                    chunk(
                        tool_calls=[
                            stream_tool(0, arguments='{"name":"防水関連"}{"name":"窓・ガラス"}')
                        ]
                    ),
                    chunk(finish_reason="tool_calls"),
                ]
            )
        )
        out = list(g.generate_stream("q", CTX, tools=ADMIN_TOOLS, is_admin=True))
        assert out[-1]["actions"] == [
            {"name": "create_folder", "input": {"name": "防水関連"}},
            {"name": "create_folder", "input": {"name": "窓・ガラス"}},
        ]

    def test_分割された引数を連結してから解釈する(self):
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(tool_calls=[stream_tool(0, name="create_folder")]),
                    chunk(tool_calls=[stream_tool(0, arguments='{"admin_only": ')]),
                    chunk(tool_calls=[stream_tool(0, arguments='true, "name": "')]),
                    chunk(tool_calls=[stream_tool(0, arguments="防水・シーリング")]),
                    chunk(tool_calls=[stream_tool(0, arguments='"}')]),
                    chunk(finish_reason="tool_calls"),
                ]
            )
        )
        out = list(g.generate_stream("q", CTX, tools=ADMIN_TOOLS, is_admin=True))
        assert out[-1]["actions"] == [
            {
                "name": "create_folder",
                "input": {"admin_only": True, "name": "防水・シーリング"},
            }
        ]

    def test_ツールが始まったら合図を1回出して以降は流さない(self):
        # 実行前の「作成します」だけが画面に残るのを防ぐ(Bedrock版と同じ振る舞い)
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(content="作成します。"),
                    chunk(tool_calls=[stream_tool(0, name="create_folder")]),
                    chunk(tool_calls=[stream_tool(0, arguments='{"name": "防水"}')]),
                    chunk(content="作りました。"),
                    chunk(finish_reason="tool_calls"),
                ]
            )
        )
        out = list(g.generate_stream("q", CTX, tools=ADMIN_TOOLS, is_admin=True))
        assert [o["type"] for o in out] == ["delta", "tool", "done"]
        assert out[0]["text"] == "作成します。"
        # 全文にはツール宣言後の分も残す(除去はmain.py側の仕事)
        assert out[-1]["answer"] == "作成します。作りました。"

    def test_思考フィールドが混ざっても流さない(self):
        g = gen(
            lambda kwargs: iter(
                [
                    chunk(content=None, reasoning_content="Okay, let me think..."),
                    chunk(content="床鳴りは施工店へ。"),
                    chunk(finish_reason="stop"),
                ]
            )
        )
        out = list(g.generate_stream("q", CTX))
        assert [o["type"] for o in out] == ["delta", "done"]
        assert out[-1]["answer"] == "床鳴りは施工店へ。"

    def test_choicesが空の断片を読み飛ばす(self):
        # 使用量だけを載せたチャンクが混ざる
        g = gen(
            lambda kwargs: iter(
                [
                    SimpleNamespace(choices=[]),
                    chunk(content="本文"),
                    chunk(finish_reason="stop"),
                ]
            )
        )
        out = list(g.generate_stream("q", CTX))
        assert out[-1]["answer"] == "本文"

    def test_ツール記法が漏れたら流し切る前に止める(self):
        leaked = "create_folder<arg_key>name</arg_key>"
        g = gen(
            lambda kwargs: iter(
                [chunk(content=leaked), chunk(finish_reason="stop")]
            )
        )
        with pytest.raises(RuntimeError, match="ツール呼び出しを本文"):
            list(g.generate_stream("q", CTX, tools=ADMIN_TOOLS, is_admin=True))

    def test_本文もツールも無ければ例外にする(self):
        g = gen(lambda kwargs: iter([chunk(finish_reason="stop")]))
        with pytest.raises(RuntimeError, match="本文もツール"):
            list(g.generate_stream("q", CTX))


class TestOtherMethods:
    def test_rewrite_queryは履歴が空でも落ちない(self):
        # eval_search.py:80 が history=[] で呼ぶ
        g = gen(lambda kwargs: reply(content=" 床鳴り 異音 きしみ "))
        assert g.rewrite_query("床が鳴る", []) == "床鳴り 異音 きしみ"

    def test_rewrite_queryが空なら例外にする(self):
        # 空文字を返すとmain.pyの検索クエリが空になり、無言で検索精度が落ちる。
        # 例外にすれば呼び出し側が握りつぶして元の質問文で検索を続ける
        g = gen(lambda kwargs: reply(content="  "))
        with pytest.raises(RuntimeError, match="クエリ拡張"):
            g.rewrite_query("床が鳴る", [])

    def test_classify_manualsはJSON配列だけ取り出す(self):
        g = gen(
            lambda kwargs: reply(
                content='```json\n[{"manual_id": "m1", "category": "床"}]\n```'
            )
        )
        out = g.classify_manuals([{"manual_id": "m1", "title": "t", "snippet": "s"}], [])
        assert out == [{"manual_id": "m1", "category": "床"}]

    def test_途中で切れた分類は例外にする(self):
        # 切れた配列でもre.searchが内側の]に当たり、件数の減った配列が通ってしまう。
        # 分類が黙って歯抜けになるより、502で止まったほうが気づける
        truncated = '[{"manual_id": "m1", "category": "床"}, {"manual_id": "m2",'
        g = gen(lambda kwargs: reply(content=truncated, finish_reason="length"))
        with pytest.raises(RuntimeError, match="切れました"):
            g.classify_manuals(
                [{"manual_id": f"m{i}", "title": "t", "snippet": "s"} for i in range(9)],
                [],
            )

    def test_途中で切れた集計も例外にする(self):
        # examplesが入れ子の配列なので、切れても内側の]にマッチしてしまう
        truncated = '[{"theme": "顛末書", "count": 2, "examples": ["a", "b"]}, {"theme":'
        g = gen(lambda kwargs: reply(content=truncated, finish_reason="length"))
        with pytest.raises(RuntimeError, match="切れました"):
            g.cluster_questions(["q1", "q2"])

    def test_JSONが無ければ例外にする(self):
        g = gen(lambda kwargs: reply(content="分類できませんでした"))
        with pytest.raises(ValueError, match="JSON"):
            g.classify_manuals([{"manual_id": "m1", "title": "t", "snippet": "s"}], [])

    def test_draft_manualは抜粋が無くても呼べる(self):
        g = gen(lambda kwargs: reply(content="# 下書き\n## 目的\n(要確認: 〜)"))
        out = g.draft_manual("退職者の手続きは?", [])
        assert out.startswith("# 下書き")
        prompt = g.client.chat.completions.calls[0]["messages"][0]["content"]
        assert "関連する既存マニュアルは見つかりませんでした" in prompt

    def test_max_tokensはBedrock版に揃える(self):
        def make(kwargs):
            if kwargs.get("stream"):
                return iter([chunk(content="本文")])
            return reply(content='[{"manual_id": "m1", "category": "床"}]')

        g = gen(make)
        g.generate("q", CTX)
        g.rewrite_query("q", [])
        g.classify_manuals([{"manual_id": "m1", "title": "t", "snippet": "s"}], [])
        g.draft_manual("q", CTX)
        assert [c["max_tokens"] for c in g.client.chat.completions.calls] == [
            1024,
            200,
            4000,
            3000,
        ]


class TestProtocol:
    def test_6メソッドが揃っている(self):
        # Protocolに書いてあってもragにはmypyもCIも無く、型検査では落ちない。
        # main.pyが呼ぶ6つが実在することをテストで固定する
        for name in (
            "generate",
            "generate_stream",
            "rewrite_query",
            "classify_manuals",
            "cluster_questions",
            "draft_manual",
        ):
            assert callable(getattr(WorkersAiAnswerGenerator, name)), name


class TestDailyQuota:
    """1日の無料枠(10,000ニューロン)を使い切った429を、一時的なものと区別する。

    区別しないと、しばらく直らない429を3回投げ直したうえで
    (実測3.7〜6.7秒)英文の RateLimitError が画面にそのまま出る。
    """

    def test_日次枠の429は再試行せず日本語で止める(self, monkeypatch):
        waits: list[float] = []
        monkeypatch.setattr(llm.time, "sleep", lambda seconds: waits.append(seconds))
        g = raising_gen([api_error(RateLimitError, 429, DAILY_QUOTA_BODY)])
        with pytest.raises(RuntimeError, match="AIの無料枠を使い切りました"):
            g.generate("q", CTX)
        # 投げ直さない(待ち時間を足しても結果は変わらない)
        assert len(g.client.chat.completions.calls) == 1
        assert waits == []
        # 回復時刻を約束しない。実測では枯渇の翌日(UTC)に管理画面が
        # 「今日 0/10,000」と出していてもAPIは429のままだった(llm.py の注記)
        assert "数時間〜1日" in DAILY_QUOTA_MESSAGE
        assert "9時" not in DAILY_QUOTA_MESSAGE

    def test_codeが拾えなくても本文の文言で日次枠と分かる(self):
        body = {
            "error": {
                "message": "you have used up your daily free allocation of 10,000 neurons"
            }
        }
        g = raising_gen([api_error(RateLimitError, 429, body)])
        with pytest.raises(RuntimeError, match="AIの無料枠を使い切りました"):
            g.generate("q", CTX)
        assert len(g.client.chat.completions.calls) == 1

    def test_ストリームでも日次枠の429を日本語にする(self):
        g = raising_gen([api_error(RateLimitError, 429, DAILY_QUOTA_BODY)])
        with pytest.raises(RuntimeError, match="AIの無料枠を使い切りました"):
            list(g.generate_stream("q", CTX))

    def test_一時的な429は今までどおり再試行する(self, monkeypatch):
        # 瞬間的なレート制限は少し待てば通る。日次枠と一緒に諦めてはいけない
        waits: list[float] = []
        monkeypatch.setattr(llm.time, "sleep", lambda seconds: waits.append(seconds))
        throttled = {"errors": [{"message": "Too many requests", "code": 1015}]}
        g = raising_gen([api_error(RateLimitError, 429, throttled)] * 2)
        answer, _ = g.generate("q", CTX)
        assert answer == "本文"
        assert len(g.client.chat.completions.calls) == 3
        assert waits == [0.5, 1.0]

    def test_400は再試行しない(self, monkeypatch):
        # 同じものを投げ直しても同じ結果にしかならない
        waits: list[float] = []
        monkeypatch.setattr(llm.time, "sleep", lambda seconds: waits.append(seconds))
        body = {"errors": [{"message": "request body exceeds the maximum supported size"}]}
        g = raising_gen([api_error(BadRequestError, 400, body)])
        with pytest.raises(BadRequestError):
            g.generate("q", CTX)
        assert len(g.client.chat.completions.calls) == 1
        assert waits == []

    def test_5xxは諦めるまでに4回試す(self, monkeypatch):
        # SDK の max_retries=3 と同じ回数(初回 + 3回)
        waits: list[float] = []
        monkeypatch.setattr(llm.time, "sleep", lambda seconds: waits.append(seconds))
        g = raising_gen([api_error(InternalServerError, 503)] * 9)
        with pytest.raises(InternalServerError):
            g.generate("q", CTX)
        assert len(g.client.chat.completions.calls) == 4
        assert waits == [0.5, 1.0, 2.0]

    def test_SDK側の再試行は使わない(self, monkeypatch):
        # 二重に再試行すると、日次枠切れの待ち時間が元に戻る
        monkeypatch.setenv("ANSWER_PROVIDER", "workers_ai")
        monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
        monkeypatch.setenv("CF_API_TOKEN", "tok")
        assert create_answer_generator().client.max_retries == 0


class TestCreateAnswerGenerator:
    def test_workers_aiには鍵が要る(self, monkeypatch):
        monkeypatch.setenv("ANSWER_PROVIDER", "workers_ai")
        monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
        monkeypatch.delenv("CF_API_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match="ANSWER_PROVIDER=workers_ai"):
            create_answer_generator()

    def test_既定はglmではなくgemma(self, monkeypatch):
        # glmはCloudflare側のツール解析が壊れていて、管理操作が黙って動かなくなる
        monkeypatch.setenv("ANSWER_PROVIDER", "workers_ai")
        monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
        monkeypatch.setenv("CF_API_TOKEN", "tok")
        monkeypatch.delenv("CF_CHAT_MODEL", raising=False)
        g = create_answer_generator()
        assert isinstance(g, WorkersAiAnswerGenerator)
        assert g.model == "@cf/google/gemma-4-26b-a4b-it"
        assert "acct/ai/v1" in str(g.client.base_url)

    def test_モデルはenvで差し替えられる(self, monkeypatch):
        monkeypatch.setenv("ANSWER_PROVIDER", "workers_ai")
        monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
        monkeypatch.setenv("CF_API_TOKEN", "tok")
        monkeypatch.setenv("CF_CHAT_MODEL", "@cf/openai/gpt-oss-120b")
        assert create_answer_generator().model == "@cf/openai/gpt-oss-120b"

    def test_既定はstubのまま(self, monkeypatch):
        monkeypatch.delenv("ANSWER_PROVIDER", raising=False)
        assert type(create_answer_generator()).__name__ == "StubAnswerGenerator"
