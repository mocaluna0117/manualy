"""検索で見つけたマニュアル抜粋をもとに、回答文を生成するプロバイダ。

- StubAnswerGenerator: ローカル開発用。定型文を返す(AWS不要)
- BedrockAnswerGenerator: AWS時代の本番用。Claude(Bedrock)がマニュアルに基づいた回答を書く
- WorkersAiAnswerGenerator: 移行後の本番用。Cloudflare Workers AI の gemma が同じ役割をこなす

環境変数 ANSWER_PROVIDER=stub|bedrock|workers_ai で切り替える。
Claude と gemma は別のモデルなので回答の癖が違う。同じ抜粋を渡しても言い回し・
箇条書きの粒度・選択肢の選び方は一致しない。揃うことを前提にした比較をしないこと。
ただし [参照] / [選択肢] の目印だけは両者で必ず守らせる。ここは main.py が
機械的に解釈していて、崩れると引用と選択肢ボタンが静かに壊れるため。
"""

import base64
import json
import os
import re
import time
from typing import Protocol

# RAGの心臓部: 「抜粋だけを根拠に答えろ」と縛ることで、
# モデルが知らないことを勝手に創作する(ハルシネーション)のを防ぐ。
# さらに「曖昧なら絞り込み質問を返す」ことで、何も分からない人でも対話でたどり着ける
SYSTEM_PROMPT = """あなたは社内マニュアル検索の案内係です。相手は社内の仕組みやマニュアルに詳しくない人だと考えて、専門用語を避け、やさしい言葉で案内してください。

次のルールを必ず守ってください。

- 挨拶・お礼・前置きは書かず、最初の1文から用件(答え、または絞り込みの質問)に入る。「ありがとうございます」「こんにちは」「マニュアル抜粋をいただきました」のような書き出しは禁止
- 「マニュアル抜粋」は利用者には見えない内部の仕組みなので、回答の中でその存在に触れない。根拠を示すときは「抜粋によると」ではなく「〇〇(マニュアル名)によると」と書く
- 提供された「マニュアル抜粋」の内容だけを根拠にする。抜粋に書かれていないことは推測しない
- 質問が具体的で該当マニュアルが明確な場合: マニュアル名とページ(例: p.3)を示し、手順を簡潔に案内する
- 状況が曖昧、または複数のマニュアルが当てはまりそうな場合: すぐに答えを出さず、状況を絞り込むための質問を1つだけ返す
- 選択肢を提示するとき(絞り込みの質問・次の提案のどちらも)は、必ずメッセージの最後に、1行につき1つ、次の形式だけで書く(この行は画面上でクリックできるボタンになる):
[選択肢] 選択肢の内容
  - この形式以外(番号付きリスト、スラッシュ区切り、「選択肢:」というラベル書き)は絶対に使わない
  - 選択肢は2〜4個、違いが誰にでも分かる短い言葉にする
  - 本文の中で選択肢の内容を繰り返さないこと
- 相手が選択肢に答えたら、その内容を踏まえて絞り込んだ案内をする
- 具体的に回答できた場合も、メッセージの最後に「次に知りたくなりそうなこと」を[選択肢]形式で2〜3個提案する(例: 関連する手順、注意点、別のケース、お客様への説明例)。ただし抜粋から答えられる内容に限る
- どのマニュアルにも該当しそうにない場合: 正直にそう伝え、問い合わせ先(担当部署など)への相談を提案する
- 手順を説明するときは箇条書きを使う
- そのままコピーして使える文章(メール本文・件名・お客様への説明文・テンプレート文など)は、必ずコードブロック(```で囲む)で示す。画面上でその部分だけをコピーできるボタンが付くため。説明や補足はコードブロックの外に書く
- メッセージの一番最後に、実際に回答の根拠として使った抜粋の番号を「[参照] 1,3」の形式で1行だけ書く。読んだが使わなかった抜粋は含めない。どの抜粋も使っていない場合は「[参照] なし」と書く。[選択肢]行がある場合は[参照]行をその前に置く"""


# 管理者のチャットにだけ渡す「道具」。Claudeは依頼内容から使うべきツールを判断して
# 呼び出しを返すだけで、実行するのはNestJS側(このサービスはDBの分類を直接触らない)
ADMIN_TOOLS = [
    {
        "toolSpec": {
            "name": "create_folder",
            "description": (
                "マニュアルを整理するフォルダ(カテゴリ)を新しく作成する。"
                "管理者に「フォルダを作って」と明確に頼まれたときだけ使う。"
                "複数作る場合は1つずつ複数回呼び出す"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "フォルダ名(誰にでも分かる簡潔な日本語)",
                        },
                        "admin_only": {
                            "type": "boolean",
                            "description": (
                                "管理者だけに見せるフォルダにするならtrue。"
                                "「鍵付き」「管理者だけ」「他の人には見せない」"
                                "「非公開」のように、見せる範囲を絞る意図が"
                                "はっきり示されたときだけtrueにする。"
                                "指示が無ければ省略する(全員に見えるフォルダになる)"
                            ),
                        },
                    },
                    "required": ["name"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "update_folder",
            "description": (
                "既にあるフォルダ(カテゴリ)の設定を変える。名前の変更と、"
                "見せる範囲(管理者だけに見せるか)の変更ができる。"
                "「〇〇フォルダの名前を△△に変えて」「〇〇フォルダを鍵付きにして」"
                "「〇〇を全員に見えるようにして」のような依頼に使う。"
                "作り直すのではなく今ある箱を書き換えるので、中のマニュアルは"
                "そのまま残る。new_nameとadmin_onlyの少なくとも一方を指定する"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "folder": {
                            "type": "string",
                            "description": (
                                "対象のフォルダの今の名前(一部でもよい)。"
                                "直前の会話で作ったフォルダを指しているなら、その名前"
                            ),
                        },
                        "new_name": {
                            "type": "string",
                            "description": (
                                "新しいフォルダ名。名前を変えないなら省略する"
                            ),
                        },
                        "admin_only": {
                            "type": "boolean",
                            "description": (
                                "管理者だけに見せるならtrue、全員に見せるならfalse。"
                                "見せる範囲を変えないなら省略する(今の設定のまま)"
                            ),
                        },
                    },
                    "required": ["folder"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "delete_folder",
            "description": (
                "フォルダ(カテゴリ)をゴミ箱へ移す。"
                "「〇〇フォルダを削除して」「いらないので消して」のような依頼に使う。"
                "中にマニュアルが入っていれば一緒にゴミ箱へ移る(あとで元に戻せる)"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "folder": {
                            "type": "string",
                            "description": "削除するフォルダの名前(一部でもよい)",
                        }
                    },
                    "required": ["folder"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "move_manual",
            "description": (
                "特定のマニュアル1件を、指定のフォルダへ今すぐ移動する。"
                "「〇〇のマニュアルを△△に入れて」のように、その1件をどうしたいかの"
                "指示に使う。今後の分類方針を決めたい場合は"
                "add_classification_ruleを使う(両方の意図があるなら両方呼ぶ)"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "manual": {
                            "type": "string",
                            "description": "移動するマニュアル名(一部でもよい)。例:「床鳴り」",
                        },
                        "folder": {
                            "type": "string",
                            "description": (
                                "移動先のフォルダ名(一部でもよい)。"
                                "分類を外して未分類に戻す場合は「未分類」"
                            ),
                        },
                    },
                    "required": ["manual", "folder"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "add_classification_rule",
            "description": (
                "分類ルールを追加する。管理者が「今後〜は〜のフォルダに分類して」のように、"
                "以後の自動分類で守ってほしい方針・好みを伝えたときに使う。"
                "保存されたルールは、アップロード時の自動分類や全件再分類のすべてで最優先適用される"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "ルールの内容(自然文のまま。例:「床暖房関連はフローリング関連に入れる」)",
                        }
                    },
                    "required": ["text"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "list_classification_rules",
            "description": "登録済みの分類ルールを一覧表示する。「分類ルールを見せて」のような依頼で使う",
            "inputSchema": {"json": {"type": "object", "properties": {}}},
        }
    },
    {
        "toolSpec": {
            "name": "remove_classification_rule",
            "description": (
                "分類ルールを削除する。どのルールかは可能な限りtextで指定する"
                "(番号は会話の途中でずれるため信頼できない)。"
                "削除対象が曖昧なときはシステムが候補を返すので、"
                "推測で番号を埋めず、分かっている手がかりをtextに入れる"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "削除するルールの文言(一部でもよい)。例:「床暖房」",
                        },
                        "number": {
                            "type": "integer",
                            "description": (
                                "補助。直前に表示した一覧の番号(1始まり)が確実に分かる場合だけ使う"
                            ),
                        },
                    },
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "reclassify_all_manuals",
            "description": (
                "登録済みの全マニュアルをAIがフォルダへ再分類し直す(必要なら新しい"
                "フォルダも作られる)。フォルダ構成の一括整理に使う。"
                "実行前にシステムが管理者へ確認を取るので、このツールは提案として呼んでよい"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "instruction": {
                            "type": "string",
                            "description": (
                                "分類の方針(任意)。管理者の依頼に方針が含まれていたら"
                                "そのまま渡す。例:「工種ごとに」「部署ごとに」"
                            ),
                        }
                    },
                }
            },
        }
    },
]

# 管理者モードのときだけシステムプロンプトに足す補足。
# 本則の「抜粋だけを根拠に・曖昧なら絞り込み質問」が管理操作にまで効くと
# ツールを呼ばずに聞き返してしまうため、管理操作は別扱いだと明確に書く
ADMIN_SYSTEM_ADDENDUM = """

補足(管理者モード): あなたはツールでフォルダ(カテゴリ)の作成・全マニュアルの再分類・分類ルールの管理ができます。
- 「特定の1件をどうするか」と「今後の方針」を取り違えない。前者(例:「〇〇のマニュアルをフローリング関連に入れて」)はmove_manualで今すぐ動かす。後者(例:「床暖房関連は今後フローリング関連に入れて」「延長保証の資料はまとめて」)はadd_classification_ruleで保存する。ルールは次の分類まで反映されないので、目の前の1件を動かしてほしい依頼にルールだけで応えてはいけない(両方の意図があるなら両方呼ぶ)
- 「〇〇というフォルダを作って」「マニュアルを再分類して」のような依頼は、マニュアルの内容に関する質問ではなく、この検索システム自体への操作依頼。マニュアル抜粋に根拠を求めず、絞り込み質問もせず、ためらわずに対応するツールを呼び出す
- 対象のマニュアル名やフォルダ名が曖昧でも、聞き返さずにmove_manualを呼ぶ。当てはまるものが複数あったり見つからない場合は、システムが候補を出して確認するので、あなたが候補を推測して並べる必要はない
- move_manualは1回につき1件だけ動かす。「〇〇を全部△△へ」「まとめて移動して」のように複数を指す依頼では、題名を勝手に1つ選んで呼んではいけない。依頼文に出てきた言葉(例:「施工説明書」)をそのままmanualに渡すこと。システムが当てはまるものを一覧にして、1件ずつ選べるようにする
- 何件もまとめて動かしたい相手には、画面の一覧でチェックを付けてフォルダへドラッグする方法も案内してよい
- あなたの応答は1回で完結する。ツールの実行結果を見てから次のツールを呼ぶことはできない。複数の操作が必要な依頼(例:「フォルダを作って再分類して」)では、必要なツールをすべて同じ応答の中でまとめて呼ぶ
- 会話履歴にある「📏 分類ルールを追加しました」「📁 フォルダを作成しました」等の実行結果はシステムが書いたもの。あなたがそれを真似て書いてはいけない。どの操作も、対応するツールをその応答で呼ばない限り実行されない
- 「再分類して」と依頼されたら、分類の方針を聞き返さずにすぐreclassify_all_manualsを呼ぶ(方針が依頼文に書かれていた場合だけinstructionに渡す。実行前の確認はシステムが行う)
- 本文で「再分類します」と宣言するだけでは何も実行されない。再分類する意図があるなら、必ずreclassify_all_manualsを同じ応答で呼ぶ(再分類はフォルダが足りなければ自動で作るので、フォルダ作成を先に済ませる必要はない)
- フォルダ名が指定されていれば、その名前のままcreate_folderを呼ぶ(勝手に変えない)
- このシステムでは、フォルダの作成・名前の変更・見せる範囲(鍵付き)の変更・削除がすべてできる。「その機能はありません」と答えてはいけない
- フォルダは1階層だけで、フォルダの中にフォルダ(サブフォルダ)は作れない。「〇〇フォルダの中に△△を作る」「階層に分ける」といった提案をしてはいけない。工種などで区別したいときは、フォルダ名に含めて表す(例:「床・フローリング_施工説明書」)
- 「フォルダ名を△△に変えて」のような名前の変更は、必ずupdate_folderを使う。create_folderで作り直してはいけない(同じ中身の箱が2つでき、元の箱が空のまま残る)。直前の会話で作ったフォルダに対する変更依頼も同じ
- 既にあるフォルダを「鍵付きにして」「管理者だけに見せて」と頼まれたら、update_folderにadmin_only=trueを渡す(名前は変えないのでnew_nameは省略する)。逆に「全員に見えるようにして」ならadmin_only=false
- 鍵付き(管理者だけに表示)のフォルダも、マニュアルの行き先として普通に指定できる。move_manualや再分類で避ける必要はない
- ただし鍵付きフォルダの中身は、回答の根拠となる抜粋には含まれない。鍵付きに入れた資料の内容を聞かれて抜粋が無いときは、鍵付きはAIの回答には使わない設定であることを伝え、画面左のフォルダから直接開くよう案内する
- 「〇〇フォルダを削除して」と頼まれたらdelete_folderを呼ぶ。ゴミ箱へ移るだけで元に戻せるので、ためらわずに実行してよい
- 「鍵付きにして」「管理者だけに見せて」「他の人には見せないで」のように見せる範囲を絞る指示があれば、create_folderのadmin_onlyをtrueにする。これはこの検索システム自体のフォルダの設定なので、Box等ほかの保管場所の権限設定と取り違えて断ってはいけない。指示が無ければadmin_onlyは省略する
- マニュアルの内容を知りたい通常の質問には、これまで通り抜粋から回答する(ツールは使わない)。例えば「Boxへの資料保管ルール」「共有フォルダの命名規則」のような、業務でのフォルダ運用についての質問は、この検索システムのフォルダ操作ではないのでツールを使わずに抜粋から答える
- ツールを使うときは、何をするのかを本文で一言だけ添える(結果の報告はシステムが行うので不要)
- 管理操作の応答では[選択肢]や[参照]の行は書かない"""

# 一般ユーザー(MEMBER)のときに足す補足。
# 管理者専用の操作を頼まれたときに、マニュアル検索で代用しようとして
# 話が噛み合わなくなるのを防ぐ
MEMBER_SYSTEM_ADDENDUM = """

補足(権限について): この検索システムには管理者だけが行える操作があります。
具体的には、フォルダ(カテゴリ)の作成・名前変更・削除・並び替え、マニュアルの分類や全体の再分類、マニュアルの追加・削除、利用者の管理です。

- 相手がこれらの操作を「してほしい」と依頼している場合は、マニュアルを検索して似た情報で代用しようとせず、その操作は管理者のみが行えることを伝え、管理者へ依頼するよう案内する。この場合は[参照]なしとする
- ただし、マニュアルに書かれている業務上のやり方についての質問は、これまで通り抜粋から回答する。例えば「Boxへの資料保管ルール」「共有フォルダの命名規則」「書類の格納先」などは業務の質問であり、この検索システムの操作ではない
- 見分け方: この検索システムの画面を操作してほしいのか、業務のやり方を知りたいのか。「(この)アプリで」「ここで」「マニュアル検索の」といった言い方や、画面に見えているフォルダを指している場合は前者
- どちらか判断できないときは、勝手にどちらかに決めず、どちらの意味かを確かめる質問を1つだけ返す"""


class Context:
    """回答の根拠となるマニュアル抜粋"""

    def __init__(self, title: str, content: str):
        self.title = title
        self.content = content


class HistoryMessage(Protocol):
    """会話のこれまでのやりとり(役割は 'user' | 'assistant')"""

    role: str
    content: str


class AnswerGenerator(Protocol):
    def generate(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
        is_admin: bool = False,
    ) -> tuple[str, list[dict]]: ...

    def generate_stream(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
        is_admin: bool = False,
    ): ...

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str: ...

    def classify_manuals(
        self,
        manuals: list[dict],
        categories: list[str],
        allow_new: bool = True,
        instruction: str | None = None,
        rules: list[str] | None = None,
    ) -> list[dict]: ...

    def cluster_questions(self, questions: list[str]) -> list[dict]: ...

    def draft_manual(self, question: str, contexts: list[Context]) -> str: ...

    def prepare_images(
        self, images: list[tuple[bytes, str]]
    ) -> list[tuple[bytes, str]]: ...


class StubAnswerGenerator:
    """開発用: LLMを呼ばずに定型文を返す"""

    def prepare_images(
        self, images: list[tuple[bytes, str]]
    ) -> list[tuple[bytes, str]]:
        # 開発用は画像をどこへも送らないので、そのまま返す
        return images

    def generate(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
        is_admin: bool = False,
    ) -> tuple[str, list[dict]]:
        return (
            f"「{question}」に関連しそうなマニュアルが{len(contexts)}件見つかりました。"
            "詳しくは以下をご覧ください。(回答文の生成はANSWER_PROVIDER=bedrockで有効になります)",
            [],
        )

    def generate_stream(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
        is_admin: bool = False,
    ):
        # LLM無しでも動きを確かめられるよう、定型文を数文字ずつ流す
        answer, actions = self.generate(
            question, contexts, images, history, tools, is_admin
        )
        for i in range(0, len(answer), 8):
            yield {"type": "delta", "text": answer[i : i + 8]}
        yield {"type": "done", "answer": answer, "actions": actions}

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str:
        # LLM無しの簡易版: 直近のユーザー発言をつなげるだけ
        recent = " ".join(h.content for h in history[-4:] if h.role == "user")
        return f"{recent} {question}".strip()

    def classify_manuals(
        self,
        manuals: list[dict],
        categories: list[str],
        allow_new: bool = True,
        instruction: str | None = None,
        rules: list[str] | None = None,
    ) -> list[dict]:
        return []  # LLM無しでは分類できない(空=何も割り当てない)

    def cluster_questions(self, questions: list[str]) -> list[dict]:
        # LLM無しでは意味でまとめられないので、同じ文面だけを数える
        counts: dict[str, int] = {}
        for q in questions:
            counts[q] = counts.get(q, 0) + 1
        return [
            {"theme": q, "count": n, "examples": [q]}
            for q, n in sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
        ]

    def draft_manual(self, question: str, contexts: list[Context]) -> str:
        return (
            f"# {question}\n\n"
            "(下書きの生成はANSWER_PROVIDER=bedrockで有効になります)\n"
        )


class BedrockAnswerGenerator:
    """本番用: Claude(Bedrock Converse API)で回答を生成する"""

    def __init__(self, model_id: str, region: str):
        from bedrock import create_bedrock_client

        self.client = create_bedrock_client(region)
        self.model_id = model_id

    def prepare_images(
        self, images: list[tuple[bytes, str]]
    ) -> list[tuple[bytes, str]]:
        # Bedrock は今までどおり元の画像をそのまま見せる。ここで縮めると
        # 切り替え日まで本番のAWS版で、写真の細かい文字の読み取りが変わってしまう
        return images

    def _converse_args(
        self, system_prompt: str, messages: list[dict], tools: list[dict] | None
    ) -> dict:
        """converse / converse_stream に渡す引数(両者で同じ条件にする)"""
        return {
            "modelId": self.model_id,
            "system": [{"text": system_prompt}],
            "messages": messages,
            "inferenceConfig": {
                "maxTokens": 1024,
                "temperature": 0.2,  # 事実ベースの回答なので低め(創造性を抑える)
            },
            # ツール(管理操作)は管理者のリクエストのときだけ渡される
            **({"toolConfig": {"tools": tools}} if tools else {}),
        }

    def _build_messages(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None,
        history: list[HistoryMessage] | None,
    ) -> list[dict]:
        """抜粋・会話履歴・画像から、Claudeに渡すmessagesを組み立てる"""
        # 抜粋に番号を振る([参照]行で「どれを使ったか」を申告してもらうため)
        excerpts = "\n\n".join(
            f"【抜粋{i}】{c.title}\n{c.content}"
            for i, c in enumerate(contexts, start=1)
        )
        user_message = f"# マニュアル抜粋\n{excerpts}\n\n# 質問\n{question}"

        # これまでの会話をそのまま前段のターンとして渡す。
        # 「1と2どちら？」→「1です」のような絞り込みの文脈をClaudeが理解できる
        messages: list[dict] = [
            {
                "role": "user" if h.role == "user" else "assistant",
                "content": [{"text": h.content}],
            }
            for h in (history or [])
        ]

        # 質問に画像が添付されていたら、Claudeに画像も一緒に見せる
        content: list[dict] = []
        for image_bytes, image_format in images or []:
            content.append(
                {"image": {"format": image_format, "source": {"bytes": image_bytes}}}
            )
        if content:
            count = "" if len(content) == 1 else f"{len(content)}枚"
            user_message += (
                f"\n(質問には上の画像{count}が添付されています。"
                "画像の内容も踏まえて回答してください)"
            )
        content.append({"text": user_message})
        messages.append({"role": "user", "content": content})
        return messages

    def generate_stream(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
        is_admin: bool = False,
    ):
        """回答を少しずつ返す。文字の断片を順に、最後に確定した全文とツール要求を返す。

        yieldするもの:
        - {"type": "delta", "text": "..."} … 追加された文字
        - {"type": "tool"} … ツール(管理操作)の呼び出しが始まった合図。
          以降の断片は出さない(実行前の宣言を回答として見せないため)
        - {"type": "done", "answer": "全文", "actions": [...]} … 最後に1回
        """
        messages = self._build_messages(question, contexts, images, history)
        system_prompt = SYSTEM_PROMPT + (
            ADMIN_SYSTEM_ADDENDUM if is_admin else MEMBER_SYSTEM_ADDENDUM
        )
        res = self.client.converse_stream(
            **self._converse_args(system_prompt, messages, tools)
        )

        answer_parts: list[str] = []
        actions: list[dict] = []
        # ツール呼び出しの入力はJSON文字列が分割されて届くので、繋いでから解釈する
        tool_name: str | None = None
        tool_input = ""
        has_tool = False

        for event in res["stream"]:
            if "contentBlockStart" in event:
                start = event["contentBlockStart"].get("start", {})
                if "toolUse" in start:
                    has_tool = True
                    tool_name = start["toolUse"].get("name")
                    tool_input = ""
                    yield {"type": "tool"}
            elif "contentBlockDelta" in event:
                delta = event["contentBlockDelta"].get("delta", {})
                if "text" in delta:
                    answer_parts.append(delta["text"])
                    # ツールが絡む応答は実行結果で本文ごと差し替わるので、
                    # 途中経過を見せない(「作成します」だけが残るのを防ぐ)
                    if not has_tool:
                        yield {"type": "delta", "text": delta["text"]}
                elif "toolUse" in delta:
                    tool_input += delta["toolUse"].get("input", "")
            elif "contentBlockStop" in event:
                if tool_name is not None:
                    try:
                        parsed = json.loads(tool_input) if tool_input.strip() else {}
                    except json.JSONDecodeError:
                        parsed = {}
                    actions.append({"name": tool_name, "input": parsed})
                    tool_name = None
                    tool_input = ""

        yield {
            "type": "done",
            "answer": "".join(answer_parts).strip(),
            "actions": actions,
        }

    def generate(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
        is_admin: bool = False,
    ) -> tuple[str, list[dict]]:
        messages = self._build_messages(question, contexts, images, history)
        system_prompt = SYSTEM_PROMPT + (
            ADMIN_SYSTEM_ADDENDUM if is_admin else MEMBER_SYSTEM_ADDENDUM
        )
        res = self.client.converse(**self._converse_args(system_prompt, messages, tools))

        # 応答は「本文テキスト」と「ツール呼び出し」が混在しうるので分けて返す
        answer_parts: list[str] = []
        actions: list[dict] = []
        for block in res["output"]["message"]["content"]:
            if "text" in block:
                answer_parts.append(block["text"])
            elif "toolUse" in block:
                tool_use = block["toolUse"]
                actions.append(
                    {"name": tool_use["name"], "input": tool_use.get("input") or {}}
                )
        return "\n".join(answer_parts).strip(), actions

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str:
        """質問(+会話の文脈)を「検索用キーワード列」に展開する(クエリ拡張)。

        - 「2です」のような返事は、直前のやりとりと合わせて独立したクエリにする
        - 同義語や言い換えも足す(例: フリーダイヤル → 電話番号 連絡先 0800)。
          マニュアル側と質問者の語彙のずれをここで吸収する
        """
        convo = "\n".join(
            f"{'質問者' if h.role == 'user' else '案内係'}: {h.content[:300]}"
            for h in history[-6:]
        )
        prompt = (
            "以下は社内マニュアル検索での会話です。最後の発言の意図を踏まえて、"
            "マニュアル検索に使うキーワード列を作ってください。\n"
            "- 質問の言い換え・同義語・関連する正式名称や表記も含める"
            "(例:「フリーダイヤル」なら 電話番号 連絡先 0800 0120 コールセンター など)\n"
            "- スペース区切りで10語以内。キーワード列だけを出力\n\n"
            f"{convo}\n質問者: {question}"
        )
        res = self.client.converse(
            modelId=self.model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 200, "temperature": 0},
        )
        return res["output"]["message"]["content"][0]["text"].strip()

    def classify_manuals(
        self,
        manuals: list[dict],
        categories: list[str],
        allow_new: bool = True,
        instruction: str | None = None,
        rules: list[str] | None = None,
    ) -> list[dict]:
        """マニュアル一覧をカテゴリに割り当てる(全体を1回のリクエストで見せて
        一貫性のある分類にする)。戻り値: [{"manual_id":…, "category":…}]

        allow_new=False のときは既存カテゴリだけに割り当てる。
        instruction は管理者が指定した分類方針(例:「工種ごとに」)。
        rules は管理者が蓄積した分類ルール(最優先で適用する)。
        """
        # 冒頭の長さ。ここを短く切ると、分類ルールが指す文言(表紙の脚注など)が
        # 落ちて、ルールを登録しても効かない。呼び出し側が既に400文字に
        # 揃えているので、ここでは念のための上限として同じ値を使う
        snippet_chars = 400
        lines = "\n".join(
            f"- id={m['manual_id']} タイトル: {m['title']}\n"
            f"  冒頭: {m['snippet'][:snippet_chars]}"
            for m in manuals
        )
        existing = "、".join(categories) if categories else "(まだ無い)"
        if allow_new:
            # 「大雑把すぎる分類」を防ぐため、軸(工種・業務分野)と粒度の目安を明示する
            category_rules = (
                "- 工種・業務分野ごとにカテゴリを分ける"
                "(例: 漏水・水回り、床・フローリング、窓・ガラス、屋根・外壁、"
                "定期点検、顛末書・決裁書類、電話・お客様対応、社内システム・入力ルール など。"
                "例はあくまで参考にし、実際のマニュアルの内容に合わせて命名する)\n"
                "- 既存カテゴリに合うものがあればそれを使い、無ければ新しいカテゴリ名を作る\n"
                "- 新しいカテゴリ名は誰にでも分かる簡潔な日本語(2〜10文字程度)にする\n"
                "- 粒度の目安: 1カテゴリに5〜15件程度。全体を2〜3個の大きなカテゴリに"
                "まとめてしまう大雑把な分け方はしない(逆に1件だけのカテゴリを乱発しない)\n"
            )
        else:
            category_rules = (
                "- 必ず「既存カテゴリ」のいずれかをそのままの名前で割り当てる。"
                "新しいカテゴリ名を作ってはいけない\n"
            )
        instruction_text = (
            f"\n管理者が指定した分類方針(最優先で従う): {instruction}\n" if instruction else ""
        )
        rules_text = (
            "\n管理者が定めた分類ルール(どの判断よりも優先して必ず守る):\n"
            + "\n".join(f"- {r}" for r in rules)
            + "\n"
            if rules
            else ""
        )
        # 管理者のルール同士がぶつかることがある(例:「クロゼット関連は建具へ」と
        # 「※〇〇と併用する と書かれたものは共通へ」の両方に当てはまるファイル)。
        # どちらが正しいかは運用の判断なので、AIに決めさせず候補を並べて返させる
        conflict_rules = (
            "- 管理者のルールが2つ以上当てはまり、行き先が食い違うファイルは、"
            "自分で決めずに candidates に候補のカテゴリ名を全部入れる"
            '(例: {"manual_id": "...", "candidates": ["共通アフター対応マニュアル", "建具・内装対応"]})。'
            "このときは category を書かない\n"
            if rules
            else ""
        )
        prompt = (
            "あなたは社内マニュアルの整理係です。以下のマニュアル一覧を内容ごとにカテゴリ分けしてください。\n\n"
            "ルール:\n"
            f"{category_rules}"
            f"{conflict_rules}"
            '- JSON配列のみを出力する: [{"manual_id": "...", "category": "カテゴリ名"}, ...]\n'
            f"{rules_text}{instruction_text}\n"
            f"既存カテゴリ: {existing}\n\nマニュアル一覧:\n{lines}"
        )
        res = self.client.converse(
            modelId=self.model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 4000, "temperature": 0},
        )
        text = res["output"]["message"]["content"][0]["text"]
        match = re.search(r"\[.*\]", text, re.DOTALL)  # コードフェンス等を除去
        if not match:
            raise ValueError("分類結果のJSONを取り出せませんでした")
        return json.loads(match.group(0))


    def cluster_questions(self, questions: list[str]) -> list[dict]:
        """質問文を意味の近さでテーマにまとめる。

        「顛末書の書き方は?」と「顛末書ってどう書くの」を同じテーマとして
        数えるのが目的。件数がそのまま「よく聞かれること」になり、
        マニュアルや定型文を足す判断材料になる。
        """
        # 質問が多いと出力JSONが上限で切れるため、直近から一定数に絞る。
        # 300件あれば傾向は十分に見える
        limited = questions[:300]
        numbered = "\n".join(f"{i}. {q}" for i, q in enumerate(limited, start=1))
        prompt = (
            "あなたは社内マニュアル検索システムの利用状況を分析する担当者です。\n"
            "以下は利用者がAIに投げた質問の一覧です。"
            "意味が近いものを同じテーマにまとめ、テーマごとの件数を数えてください。\n\n"
            "ルール:\n"
            "- テーマ名は、何について聞かれているかが一目で分かる簡潔な日本語(5〜20文字)にする\n"
            "- 語尾や言い回しが違うだけの質問は同じテーマにまとめる\n"
            "- 無理にまとめず、内容が違うものは別のテーマにする\n"
            "- countは、そのテーマに含めた質問の実際の件数にする(合計が入力件数を超えないこと)\n"
            "- examplesには、そのテーマの代表的な質問文を原文のまま最大3件入れる\n"
            "- 件数の多い順に並べる\n"
            '- JSON配列のみを出力する: [{"theme": "...", "count": 3, "examples": ["...", "..."]}, ...]\n\n'
            f"質問一覧({len(limited)}件):\n{numbered}"
        )
        res = self.client.converse(
            modelId=self.model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 4000, "temperature": 0},
        )
        text = res["output"]["message"]["content"][0]["text"]
        match = re.search(r"\[.*\]", text, re.DOTALL)  # コードフェンス等を除去
        if not match:
            raise ValueError("集計結果のJSONを取り出せませんでした")
        return json.loads(match.group(0))

    def draft_manual(self, question: str, contexts: list[Context]) -> str:
        """答えられなかった質問から、マニュアルの下書きを作る。

        利用状況で「足りない領域」が見えても、そこから書き始めるのは重い。
        章立てと分かっている範囲の本文を先に用意して、担当者が直す形にする。

        いちばん大事なのは、分からないことを埋めないこと。
        推測で書かれた手順がそのままマニュアルになると、
        「マニュアルに書いてあるから」と実行されてしまう。
        """
        excerpts = (
            "\n\n".join(f"【{c.title}】\n{c.content}" for c in contexts)
            if contexts
            else "(関連する既存マニュアルは見つかりませんでした)"
        )
        prompt = (
            "あなたは社内マニュアルの作成を手伝う担当者です。\n"
            "利用者から次の質問がありましたが、既存のマニュアルでは答えられませんでした。\n"
            "この質問に答えられるマニュアルの下書きを作ってください。\n\n"
            "厳守すること:\n"
            "- 事実は「関連する既存マニュアルの抜粋」に書かれていることだけを使う\n"
            "- 抜粋に無い手順・数値・連絡先・期限は絶対に書かない。"
            "必要な項目は見出しだけ用意し、本文は「(要確認: 〜)」と書いて空けておく\n"
            "- それらしい手順をでっち上げない。埋まっていない下書きの方が、"
            "間違った手順が書かれたマニュアルよりはるかに良い\n"
            "- 想像で会社の運用を決めない(担当部署名・システム名・様式名など)\n\n"
            "書き方:\n"
            "- Markdownで書く。見出しは## から始める\n"
            "- 構成: 目的 / 対象となる場面 / 手順 / 注意点 / 関連資料\n"
            "- 手順は番号付きで、1つの操作を1行にする\n"
            "- 冒頭に「# 」でマニュアルのタイトルを1行書く\n"
            "- 最後に「## この下書きについて」を置き、"
            "何を確認して埋める必要があるかを箇条書きにする\n\n"
            f"# 答えられなかった質問\n{question}\n\n"
            f"# 関連する既存マニュアルの抜粋\n{excerpts}"
        )
        res = self.client.converse(
            modelId=self.model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            # 下書きなので長さが要る。事実を作らせないよう温度は0
            inferenceConfig={"maxTokens": 3000, "temperature": 0},
        )
        return res["output"]["message"]["content"][0]["text"].strip()


# 思考(reasoning)を止めるフラグ。Workers AI の gemma も glm も推論モデルなので、
# これを送らないと英語の独り言に max_tokens を使い切り、本文が空文字で返る
# (実測: フラグ無しで reasoning_content に3,875文字、本文ゼロ、11.1秒。
#  フラグ有りで2.0秒・本文あり)。extra_body={"thinking":{"type":"disabled"}} は
# 効かず、reasoning_effort="none" は400になるので、この書き方だけが通る。
# 思考の中身は content ではなく reasoning_content という別キーに入るため、
# 読まなければ自然に捨てられる(実測でも content に混ざったことは一度も無い)
NO_THINKING_EXTRA_BODY = {"chat_template_kwargs": {"enable_thinking": False}}

# Cloudflare 側のツール解析が外れたときに、本文へそのまま出てくる生の記法。
# glm-4.7-flash で実際に観測した:
#   create_folder<arg_key>name</arg_key><arg_value>防水</arg_value></tool_call>
# このとき tool_calls は空・finish_reason は "stop" で返るので、
# 黙って通すと「実行されていないのに実行したように読める本文」が管理者に出る
TOOL_NOTATION_MARKERS = ("<arg_key>", "<arg_value>", "<tool_call>", "</tool_call>")

# Workers AI の429には性質の違う2種類がある。
#  (a) 1日の無料枠(10,000ニューロン)を使い切った429。本文は
#      "you have used up your daily free allocation of 10,000 neurons"、
#      Cloudflare 独自の形 {"errors": [{"code": 4006, ...}]} で返る。
#      何度投げても同じものが返るので、再試行は待ち時間の無駄。
#      **回復時刻は約束できない。**2026-09-09 20時台(UTC)に使い切ったあと、
#      翌日の管理画面が「今日 0/10,000」「resets at 00:00 UTC」と表示していても、
#      APIは 2026-09-10 10:52 UTC(=枯渇から約15時間後)まだ429を返し続けた。
#      日次(UTC 00:00)のリセットは当てにできないので、文言でも時刻を言わない
#  (b) 瞬間的なレート制限。少し待てば通るので従来どおり再試行する
# (a) を openai SDK の max_retries に任せると、回復しない429を3回投げ直してから
# 諦める(実測3.7〜6.7秒)。しかも上がってくるのは英文の RateLimitError なので、
# main.py:825 の『回答文の生成に失敗しました(…)』に英語がそのまま出て、
# 管理者にも利用者にも「いつ直るのか」が分からない。
DAILY_QUOTA_ERROR_CODE = 4006
DAILY_QUOTA_MARKERS = ("daily free allocation", "daily limit")
DAILY_QUOTA_MESSAGE = "AIの無料枠を使い切りました。回復まで数時間〜1日かかります"

# 自前で再試行する回数と待ち時間。SDK の max_retries=3 と同じ回数に揃えてある
# (SDK任せをやめたのは、日次枠かどうかの区別を SDK 側に教えられないため)
WORKERS_AI_RETRY_WAITS = (0.5, 1.0, 2.0)
# 投げ直す価値のあるHTTPステータス。400番台は同じものを投げても同じ結果になる
RETRYABLE_STATUS_CODES = (408, 409, 429)


def _iter_error_entries(body):
    """エラー応答の中から、code を持っていそうな辞書を拾い出す。

    Cloudflare は OpenAI 形式({"error": {...}})ではなく
    {"errors": [{"code": 4006, "message": ...}]} で返してくるので、
    SDK は code を解釈できない(実測で error.code は None)。両方の形を見る。
    """
    if not isinstance(body, dict):
        return
    errors = body.get("errors")
    if isinstance(errors, list):
        for entry in errors:
            if isinstance(entry, dict):
                yield entry
    error = body.get("error")
    if isinstance(error, dict):
        yield error
    yield body


def _is_daily_quota_error(error) -> bool:
    """1日の無料枠を使い切った429か(一時的なレート制限と区別する)"""
    if getattr(error, "status_code", None) != 429:
        return False
    for entry in _iter_error_entries(getattr(error, "body", None)):
        if entry.get("code") == DAILY_QUOTA_ERROR_CODE:
            return True
    # code が拾えない形で返ってきたときのために本文も見る
    text = str(error).lower()
    return any(marker in text for marker in DAILY_QUOTA_MARKERS)


def _call_workers_ai(create, **kwargs):
    """Workers AI を叩く。日次枠切れの429だけは再試行せず日本語の例外にする。

    再試行を openai SDK に任せられないのは、SDK が429を一律で
    「待てば直るもの」として扱うため(_create_workers_ai_client の
    max_retries=0 とセット。片方だけ直すと再試行が二重になる)。
    """
    from openai import APIConnectionError, APIStatusError

    last_error: Exception | None = None
    # 最後の1周だけ待たずに抜ける(= 初回 + WORKERS_AI_RETRY_WAITS 回の試行)
    for wait in (*WORKERS_AI_RETRY_WAITS, None):
        try:
            return create(**kwargs)
        except APIStatusError as e:
            if _is_daily_quota_error(e):
                # しばらく直らないので、待たずに何が起きたかを日本語で返す
                raise RuntimeError(DAILY_QUOTA_MESSAGE) from e
            status = e.status_code
            if status not in RETRYABLE_STATUS_CODES and status < 500:
                raise
            last_error = e
        except APIConnectionError as e:
            last_error = e
        if wait is None:
            break
        time.sleep(wait)
    raise last_error


def _to_openai_tools(tools: list[dict]) -> list[dict]:
    """ADMIN_TOOLS(Bedrockのtoolspec形式)をOpenAIのfunction形式に写す。

    変換をこの1関数に閉じ込めてあるのは、generate / generate_stream の
    2箇所(将来増えればもっと)で別々に書くと、片方だけ description を
    落とすようなズレが必ず起きるため。ADMIN_TOOLS 自体は Bedrock 版が
    そのまま使っているので書き換えない(構造を変えるとAWS版が壊れる)。

    各プロパティの description は必ず持ち越すこと。落とすと admin_only の
    「鍵付きの意図がはっきり示されたときだけ true」という条件が消え、
    モデルが勝手に非公開フォルダを作るようになる。
    """
    converted = []
    for tool in tools:
        spec = tool["toolSpec"]
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": spec["name"],
                    "description": spec["description"],
                    # inputSchema.json がそのまま JSON Schema なので丸ごと渡す
                    # (プロパティを1つずつ写すと description が落ちやすい)
                    "parameters": spec["inputSchema"]["json"],
                },
            }
        )
    return converted


def _create_workers_ai_client(timeout: float = 60.0):
    """openai SDK を Cloudflare の OpenAI互換エンドポイントに向ける。

    embedding.py にほぼ同じ関数がある。あちらを import せずに分けてあるのは、
    埋め込みと回答生成で設定ミスを巻き込み合わないため。共通化すると
    「EMBEDDING_PROVIDER の鍵が無い」という文言で回答生成が止まり、
    現場が直す場所を探せなくなる。12行の重複は承知のうえ。
    """
    # workers_ai を使うときだけ import(ローカル開発で必須にしない)
    from openai import OpenAI

    account_id = os.environ.get("CF_ACCOUNT_ID")
    token = os.environ.get("CF_API_TOKEN")
    if not account_id or not token:
        raise RuntimeError(
            "ANSWER_PROVIDER=workers_ai には CF_ACCOUNT_ID と CF_API_TOKEN が必要です"
        )
    base_url = os.environ.get(
        "CF_AI_BASE_URL",
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    )
    # 再試行はSDKに任せない(max_retries=0)。SDKは429を一律で「待てば直る」と
    # 扱うため、回復しない日次枠切れまで投げ直して時間を捨てる。代わりに
    # _call_workers_ai が種類を見分けて再試行する
    return OpenAI(base_url=base_url, api_key=token, timeout=timeout, max_retries=0)


class WorkersAiAnswerGenerator:
    """移行後の本番用: Cloudflare Workers AI(既定は gemma)で回答を生成する。

    Bedrock 版と同じ6メソッドを持ち、main.py からは見分けが付かないように振る舞う。
    プロンプトは Bedrock 版と同じ文面を使う(モデルごとに分岐させると、
    どちらの言い回しで検証したのか分からなくなるため)。
    """

    def __init__(self, model: str, client=None):
        # client を差し替えられるのは、テストで openai SDK を偽物にするため
        # (WorkersAiEmbedder と同じ形に揃えてある)
        if client is None:
            client = _create_workers_ai_client()
        self.client = client
        self.model = model

    def prepare_images(
        self, images: list[tuple[bytes, str]]
    ) -> list[tuple[bytes, str]]:
        """質問の添付画像を、Workers AI へ送れる大きさに1度だけ落とす。

        main.retrieve() がこれを通した画像を describe と generate の両方に
        使い回す。以前は describe 用に縮めたあと、_build_messages が
        元の画像からもう一度縮めていて、同じ処理が2回走っていた
        (実写4枚で0.59秒×2。0.5vCPUのCloud Runでは効いてくる)。
        境界に残してある shrink_for_upload(直接呼ぶ経路のための安全網)は、
        縮小済みの画像を見分けて素通しする。見分けは大きさだけでなく
        SHRINK_DONE_BYTES も見る。長辺1600pxでも実測1.07MBあり、
        SHRINK_SKIP_BYTES(700KB)では素通しにならず焼き直されていた。
        """
        from vision import shrink_for_upload

        return shrink_for_upload(images)

    # ── API を叩く唯一の入口 ────────────────────────────────────────────

    def _chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        max_tokens: int = 1024,
        temperature: float = 0.2,
        stream: bool = False,
    ):
        """Workers AI に投げる。全メソッドがここを通る。

        入口を1つに絞ってあるのは NO_THINKING_EXTRA_BODY の付け忘れを
        構造的に不可能にするため。1メソッドでも付け忘れると、
        そこだけ思考で max_tokens を使い切って空を返す(気づきにくい)。

        tool_choice は指定しない。"required" は400、名前指定は glm で
        引数が壊れた(ツール名を name に入れてきた)。既定の auto で
        管理操作6シナリオとも正しく判断したので、触らないのが正解。
        """
        # 再試行もここに集約する(日次枠切れの429だけは投げ直さない)
        return _call_workers_ai(
            self.client.chat.completions.create,
            model=self.model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=stream,
            **({"tools": _to_openai_tools(tools)} if tools else {}),
            extra_body=NO_THINKING_EXTRA_BODY,
        )

    # ── 応答の読み取り ──────────────────────────────────────────────────

    # 連結された引数を先頭から1つずつ切り出すための読み取り機(使い回せる)
    _JSON_DECODER = json.JSONDecoder()

    @classmethod
    def _parse_tool_arguments(cls, raw) -> list[dict]:
        """ツール呼び出しの引数を dict の一覧にする(通常は1件)。

        戻り値が一覧なのは、同じツールを2回呼ぶ依頼で、2回分の引数JSONが
        1件分の枠に連結されて届くことがあるため。実測の生応答:
          tool_calls: [{id: call_6667…, function: {name: 'create_folder',
                        arguments: '{"name":"防水関連"}{"name":"窓・ガラス"}'}}]
        これを1件として json.loads すると例外になり、main.py:825 で
        『回答文の生成に失敗しました』に化けて管理操作が1件も実行されない。
        連結を解いて2件に展開すれば、依頼どおり両方作れる。

        main.py は ActionRequest(**a) で input を dict として受け取るので、
        None や文字列のまま渡してはいけない。
        """
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            # 引数の無いツール(list_classification_rules)は空文字で来る
            return [{}]
        if isinstance(raw, dict):
            return [raw]
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            # ここで {} に握りつぶすと、名前の無い create_folder のような
            # 「引数が抜けた操作」がそのまま実行依頼として流れてしまう。
            # 連結なら解けるので、解けたときだけ複数件として通す
            return cls._split_concatenated_arguments(raw)
        # granite系は JSON文字列の中にもう一段JSONを入れて返すことがある
        if isinstance(parsed, str):
            parsed = json.loads(parsed)
        if not isinstance(parsed, dict):
            raise RuntimeError(f"ツール呼び出しの引数がオブジェクトではありません: {raw!r}")
        return [parsed]

    @classmethod
    def _split_concatenated_arguments(cls, raw: str) -> list[dict]:
        """'{…}{…}' と連結された引数を、先頭から1つずつ切り出す。

        raw_decode は「1つ読めたところで止まり、次の位置を返す」ので、
        区切り文字が無くても境界が分かる。1件しか取れなかった場合
        (=単に壊れているJSON)は、黙って通さず今までどおり例外にする。
        """
        objects: list[dict] = []
        index = 0
        while index < len(raw):
            # 区切りとして挟まっていることがある空白・カンマは読み飛ばす
            while index < len(raw) and raw[index] in " \t\r\n,":
                index += 1
            if index >= len(raw):
                break
            try:
                value, index = cls._JSON_DECODER.raw_decode(raw, index)
            except ValueError:
                objects = []
                break
            if not isinstance(value, dict):
                objects = []
                break
            objects.append(value)
        if len(objects) < 2:
            raise RuntimeError(
                f"ツール呼び出しの引数を解釈できませんでした: {raw!r}。"
                "1件ずつ指示してください"
            )
        return objects

    def _collect_tool_calls(self, message) -> list[dict]:
        """非ストリームの応答から、main.py が期待する形の actions を作る"""
        actions = []
        for call in message.tool_calls or []:
            # 引数が連結されて届いていたら、同じツールの依頼N件に展開する
            for arguments in self._parse_tool_arguments(call.function.arguments):
                actions.append({"name": call.function.name, "input": arguments})
        return actions

    @staticmethod
    def _reject_empty(text: str, actions: list[dict]) -> None:
        """本文もツール呼び出しも無い応答は失敗にする。

        空文字を正常値として返すと、画面には空の吹き出しだけが出て
        「AIが黙った」ようにしか見えない。main.py 側にも同じ検査があるが、
        気づける場所は近いほどよいので生成側でも止める
        (思考の切り忘れでmax_tokensを使い切ったときにここへ落ちる)。
        """
        if not text and not actions:
            raise RuntimeError("モデルが本文もツール呼び出しも返しませんでした")

    @staticmethod
    def _reject_tool_notation(text: str, actions: list[dict]) -> None:
        """ツール記法が本文に漏れていたら失敗にする。

        Cloudflare 側の解析が外れると、モデルは呼んだつもりでも tool_calls が
        空のまま生の記法が本文に出る。これを通すと (1)管理者の画面に
        <arg_key> が表示され (2)実行されていない操作が実行されたように読める。
        どちらも黙って壊れるより、失敗として見せたほうがましなので例外にする。
        """
        if actions:
            return
        if any(marker in text for marker in TOOL_NOTATION_MARKERS):
            raise RuntimeError(
                "モデルがツール呼び出しを本文に書き出しました"
                "(Cloudflare側の解析に失敗しています)。CF_CHAT_MODEL を確認してください"
            )

    # ── messages の組み立て ─────────────────────────────────────────────

    def _build_messages(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None,
        history: list[HistoryMessage] | None,
        is_admin: bool,
    ) -> list[dict]:
        """抜粋・会話履歴・画像から、OpenAI形式のmessagesを組み立てる。

        Bedrock 版と同じ文面・同じ順序にしてある(抜粋の番号付け、画像の枚数の
        添え書き)。ここを変えると [参照] の番号がずれる。
        違うのは、systemが別引数ではなく先頭のメッセージになる点だけ。
        """
        excerpts = "\n\n".join(
            f"【抜粋{i}】{c.title}\n{c.content}"
            for i, c in enumerate(contexts, start=1)
        )
        user_message = f"# マニュアル抜粋\n{excerpts}\n\n# 質問\n{question}"

        system_prompt = SYSTEM_PROMPT + (
            ADMIN_SYSTEM_ADDENDUM if is_admin else MEMBER_SYSTEM_ADDENDUM
        )
        messages: list[dict] = [{"role": "system", "content": system_prompt}]
        messages.extend(
            {
                "role": "user" if h.role == "user" else "assistant",
                "content": h.content,
            }
            for h in (history or [])
        )

        # 画像は data URI にして content 配列で渡す(OpenAI互換の作法)。
        # png/jpeg/webp/gif の4形式とも実機で通ることを確認済み。
        # 投げる前に縮めるのは Workers AI のボディ上限に収めるため
        # (書き起こし側と同じ関数を通す。詳しくは vision.shrink_for_upload)
        from vision import shrink_for_upload

        parts: list[dict] = []
        for image_bytes, image_format in shrink_for_upload(images or []):
            encoded = base64.b64encode(image_bytes).decode("ascii")
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/{image_format};base64,{encoded}"
                    },
                }
            )
        if parts:
            count = "" if len(parts) == 1 else f"{len(parts)}枚"
            user_message += (
                f"\n(質問には上の画像{count}が添付されています。"
                "画像の内容も踏まえて回答してください)"
            )
            parts.append({"type": "text", "text": user_message})
            messages.append({"role": "user", "content": parts})
        else:
            # 画像が無いときは素の文字列で渡す(配列にする必要が無い)
            messages.append({"role": "user", "content": user_message})
        return messages

    # ── 6メソッド ───────────────────────────────────────────────────────

    def generate(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
        is_admin: bool = False,
    ) -> tuple[str, list[dict]]:
        res = self._chat(
            self._build_messages(question, contexts, images, history, is_admin),
            tools=tools,
            max_tokens=1024,
        )
        choice = res.choices[0]
        # ツールだけを返した応答では content が None(空文字ではない)で来る
        answer = (choice.message.content or "").strip()
        actions = self._collect_tool_calls(choice.message)
        self._reject_tool_notation(answer, actions)
        self._reject_empty(answer, actions)
        return answer, actions

    def generate_stream(
        self,
        question: str,
        contexts: list[Context],
        images: list[tuple[bytes, str]] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
        is_admin: bool = False,
    ):
        """回答を少しずつ返す。yieldするものは Bedrock 版と同じ3種類。

        - {"type": "delta", "text": "..."} … 追加された文字
        - {"type": "tool"} … 以降の断片を画面に出すなの合図
        - {"type": "done", "answer": "全文", "actions": [...]} … 最後に1回
        """
        stream = self._chat(
            self._build_messages(question, contexts, images, history, is_admin),
            tools=tools,
            max_tokens=1024,
            stream=True,
        )

        answer = ""
        # ツール呼び出しは「非nullのid」を合図に新しい枠を作って溜める。
        # index は呼び出しの通し番号ではなく tools 配列の中でのそのツールの位置で、
        # 同じツールを2回呼ぶ依頼ではどちらも同じ index で届く
        # (実測: create_folder は常に0、add_classification_rule は常に4)。
        # index をキーにすると2件が1枠に潰れ、引数が
        # '{"text":"顛末書は…"}{"text":"防水は…"}' と連結されて解釈に失敗する。
        # id が付くのは各呼び出しの最初の断片だけで、続きは id=None・
        # index だけ同じ形で届くので、直前に始まった枠へ足していく
        slots: dict[object, dict] = {}
        order: list[object] = []  # 初出順。dictの順序ではなく依頼された順で実行させる
        # index ごとの「いま書き足している枠」。id を一度も送らないモデルもあるので、
        # その場合は index そのものを鍵にして従来どおり束ねる
        last_key_by_index: dict[object, object] = {}
        tool_started = False

        for chunk in stream:
            # 使用量だけを載せた choices 空のチャンクが混ざる
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta is None:
                continue

            for call in delta.tool_calls or []:
                call_id = getattr(call, "id", None)
                key = call_id or last_key_by_index.get(
                    call.index, ("index", call.index)
                )
                slot = slots.get(key)
                if slot is None:
                    # 新しい枠の name は、同じ index で直前に始まった枠から引き継ぐ。
                    # 実測で idx=4 id=call_a name='add_classification_rule' の次に
                    # idx=4 id=call_b name=None(引数だけ)が届く形があり、
                    # 素で作ると2件目が name 空になって下の組み立てで捨てられていた。
                    # index で束ねていた頃は同じ枠に入るので2件とも取れていた
                    previous = slots.get(last_key_by_index.get(call.index))
                    slot = {
                        "name": previous["name"] if previous else "",
                        "arguments": "",
                    }
                    slots[key] = slot
                    order.append(key)
                last_key_by_index[call.index] = key
                function = call.function
                if function is not None:
                    if function.name:
                        slot["name"] = function.name
                    if function.arguments:
                        # 引数は '{"admin_only": ' / 'true, "name": "' のように
                        # 途中で分割されて届くので、繋いでから解釈する
                        slot["arguments"] += function.arguments
                if not tool_started:
                    # 「以降は画面に出すな」は最初の断片で1回だけ
                    tool_started = True
                    yield {"type": "tool"}

            # reasoning_content は読まない(読まなければ捨てられる)
            text = delta.content or ""
            if text:
                answer += text
                if not tool_started:
                    yield {"type": "delta", "text": text}
                    # 記法が流れ切る前に止める。main.py は例外を受けて
                    # reset を送るので、漏れたぶんは画面から消える
                    self._reject_tool_notation(answer, [])
            # finish_reason は見ない。同じ値が最後に2回届くため、
            # これを合図にすると done が二重に出る(actionsも二重になる)

        # name の無い枠は黙って飛ばさない。飛ばすと「依頼したのに実行されず、
        # 失敗したとも言われない」管理操作ができてしまう。引き継ぎでも埋まらなければ
        # 何のツールか分からないので、例外にして main.py に失敗として出させる
        actions = []
        for key in order:
            slot = slots[key]
            if not slot["name"]:
                raise RuntimeError(
                    "ツール呼び出しの名前が分かりませんでした: "
                    f"引数={slot['arguments']!r}。1件ずつ指示してください"
                )
            for arguments in self._parse_tool_arguments(slot["arguments"]):
                actions.append({"name": slot["name"], "input": arguments})
        answer = answer.strip()
        self._reject_tool_notation(answer, actions)
        self._reject_empty(answer, actions)
        yield {"type": "done", "answer": answer, "actions": actions}

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str:
        """質問(+会話の文脈)を「検索用キーワード列」に展開する(クエリ拡張)。

        プロンプトは Bedrock 版と同じ文面。片方だけ直すと、AWS版と移行後で
        検索に使う言葉が変わってしまうので、直すときは両方直すこと。
        """
        convo = "\n".join(
            f"{'質問者' if h.role == 'user' else '案内係'}: {h.content[:300]}"
            for h in history[-6:]
        )
        prompt = (
            "以下は社内マニュアル検索での会話です。最後の発言の意図を踏まえて、"
            "マニュアル検索に使うキーワード列を作ってください。\n"
            "- 質問の言い換え・同義語・関連する正式名称や表記も含める"
            "(例:「フリーダイヤル」なら 電話番号 連絡先 0800 0120 コールセンター など)\n"
            "- スペース区切りで10語以内。キーワード列だけを出力\n\n"
            f"{convo}\n質問者: {question}"
        )
        res = self._chat(
            [{"role": "user", "content": prompt}], max_tokens=200, temperature=0
        )
        keywords = (res.choices[0].message.content or "").strip()
        if not keywords:
            # 空文字を返すと main.py:729 の retrieval_query が空になり、
            # 「何も書かれていない質問」で検索したのと同じ結果になる。
            # 例外にすれば呼び出し側が握りつぶして元の質問文で検索を続ける
            raise RuntimeError("クエリ拡張の結果が空でした")
        return keywords

    def classify_manuals(
        self,
        manuals: list[dict],
        categories: list[str],
        allow_new: bool = True,
        instruction: str | None = None,
        rules: list[str] | None = None,
    ) -> list[dict]:
        """マニュアル一覧をカテゴリに割り当てる。プロンプトは Bedrock 版と同じ文面"""
        snippet_chars = 400
        lines = "\n".join(
            f"- id={m['manual_id']} タイトル: {m['title']}\n"
            f"  冒頭: {m['snippet'][:snippet_chars]}"
            for m in manuals
        )
        existing = "、".join(categories) if categories else "(まだ無い)"
        if allow_new:
            category_rules = (
                "- 工種・業務分野ごとにカテゴリを分ける"
                "(例: 漏水・水回り、床・フローリング、窓・ガラス、屋根・外壁、"
                "定期点検、顛末書・決裁書類、電話・お客様対応、社内システム・入力ルール など。"
                "例はあくまで参考にし、実際のマニュアルの内容に合わせて命名する)\n"
                "- 既存カテゴリに合うものがあればそれを使い、無ければ新しいカテゴリ名を作る\n"
                "- 新しいカテゴリ名は誰にでも分かる簡潔な日本語(2〜10文字程度)にする\n"
                "- 粒度の目安: 1カテゴリに5〜15件程度。全体を2〜3個の大きなカテゴリに"
                "まとめてしまう大雑把な分け方はしない(逆に1件だけのカテゴリを乱発しない)\n"
            )
        else:
            category_rules = (
                "- 必ず「既存カテゴリ」のいずれかをそのままの名前で割り当てる。"
                "新しいカテゴリ名を作ってはいけない\n"
            )
        instruction_text = (
            f"\n管理者が指定した分類方針(最優先で従う): {instruction}\n" if instruction else ""
        )
        rules_text = (
            "\n管理者が定めた分類ルール(どの判断よりも優先して必ず守る):\n"
            + "\n".join(f"- {r}" for r in rules)
            + "\n"
            if rules
            else ""
        )
        conflict_rules = (
            "- 管理者のルールが2つ以上当てはまり、行き先が食い違うファイルは、"
            "自分で決めずに candidates に候補のカテゴリ名を全部入れる"
            '(例: {"manual_id": "...", "candidates": ["共通アフター対応マニュアル", "建具・内装対応"]})。'
            "このときは category を書かない\n"
            if rules
            else ""
        )
        prompt = (
            "あなたは社内マニュアルの整理係です。以下のマニュアル一覧を内容ごとにカテゴリ分けしてください。\n\n"
            "ルール:\n"
            f"{category_rules}"
            f"{conflict_rules}"
            '- JSON配列のみを出力する: [{"manual_id": "...", "category": "カテゴリ名"}, ...]\n'
            f"{rules_text}{instruction_text}\n"
            f"既存カテゴリ: {existing}\n\nマニュアル一覧:\n{lines}"
        )
        res = self._chat(
            [{"role": "user", "content": prompt}], max_tokens=4000, temperature=0
        )
        return self._parse_json_array(res.choices[0], "分類結果")

    def cluster_questions(self, questions: list[str]) -> list[dict]:
        """質問文を意味の近さでテーマにまとめる。プロンプトは Bedrock 版と同じ文面"""
        limited = questions[:300]
        numbered = "\n".join(f"{i}. {q}" for i, q in enumerate(limited, start=1))
        prompt = (
            "あなたは社内マニュアル検索システムの利用状況を分析する担当者です。\n"
            "以下は利用者がAIに投げた質問の一覧です。"
            "意味が近いものを同じテーマにまとめ、テーマごとの件数を数えてください。\n\n"
            "ルール:\n"
            "- テーマ名は、何について聞かれているかが一目で分かる簡潔な日本語(5〜20文字)にする\n"
            "- 語尾や言い回しが違うだけの質問は同じテーマにまとめる\n"
            "- 無理にまとめず、内容が違うものは別のテーマにする\n"
            "- countは、そのテーマに含めた質問の実際の件数にする(合計が入力件数を超えないこと)\n"
            "- examplesには、そのテーマの代表的な質問文を原文のまま最大3件入れる\n"
            "- 件数の多い順に並べる\n"
            '- JSON配列のみを出力する: [{"theme": "...", "count": 3, "examples": ["...", "..."]}, ...]\n\n'
            f"質問一覧({len(limited)}件):\n{numbered}"
        )
        res = self._chat(
            [{"role": "user", "content": prompt}], max_tokens=4000, temperature=0
        )
        return self._parse_json_array(res.choices[0], "集計結果")

    @staticmethod
    def _parse_json_array(choice, label: str) -> list[dict]:
        """JSON配列だけを取り出す。途中で切れていたら通さない。

        finish_reason を先に見るのが肝。max_tokens で切れた出力でも
        re.search(r"\\[.*\\]") は内側の ] に当たってしまい、
        「件数が減っただけの正しそうな配列」が返る。分類が歯抜けになっても
        誰も気づけないので、切れたと分かった時点で止める。
        (呼び出し側の /organize は502として管理者に見せる)
        """
        if choice.finish_reason == "length":
            raise RuntimeError(
                f"{label}が長さ上限で途中で切れました。"
                "一度に渡す件数を減らしてください"
            )
        text = choice.message.content or ""
        match = re.search(r"\[.*\]", text, re.DOTALL)  # コードフェンス等を除去
        if not match:
            raise ValueError(f"{label}のJSONを取り出せませんでした")
        return json.loads(match.group(0))

    def draft_manual(self, question: str, contexts: list[Context]) -> str:
        """答えられなかった質問から、マニュアルの下書きを作る。

        プロンプトは Bedrock 版と同じ文面。実機で確かめたところ、この文面のまま
        目的/対象となる場面/手順/注意点/関連資料/この下書きについて が全部そろい、
        抜粋に無いところは「(要確認: 〜)」で空けて返してきた(400〜470文字)。
        分量を増やす指示を足すと、埋まっていない欄まで埋めにきて
        「それらしい手順のでっち上げ」に近づくので足していない。
        """
        excerpts = (
            "\n\n".join(f"【{c.title}】\n{c.content}" for c in contexts)
            if contexts
            else "(関連する既存マニュアルは見つかりませんでした)"
        )
        prompt = (
            "あなたは社内マニュアルの作成を手伝う担当者です。\n"
            "利用者から次の質問がありましたが、既存のマニュアルでは答えられませんでした。\n"
            "この質問に答えられるマニュアルの下書きを作ってください。\n\n"
            "厳守すること:\n"
            "- 事実は「関連する既存マニュアルの抜粋」に書かれていることだけを使う\n"
            "- 抜粋に無い手順・数値・連絡先・期限は絶対に書かない。"
            "必要な項目は見出しだけ用意し、本文は「(要確認: 〜)」と書いて空けておく\n"
            "- それらしい手順をでっち上げない。埋まっていない下書きの方が、"
            "間違った手順が書かれたマニュアルよりはるかに良い\n"
            "- 想像で会社の運用を決めない(担当部署名・システム名・様式名など)\n\n"
            "書き方:\n"
            "- Markdownで書く。見出しは## から始める\n"
            "- 構成: 目的 / 対象となる場面 / 手順 / 注意点 / 関連資料\n"
            "- 手順は番号付きで、1つの操作を1行にする\n"
            "- 冒頭に「# 」でマニュアルのタイトルを1行書く\n"
            "- 最後に「## この下書きについて」を置き、"
            "何を確認して埋める必要があるかを箇条書きにする\n\n"
            f"# 答えられなかった質問\n{question}\n\n"
            f"# 関連する既存マニュアルの抜粋\n{excerpts}"
        )
        res = self._chat(
            # 下書きなので長さが要る。事実を作らせないよう温度は0
            [{"role": "user", "content": prompt}], max_tokens=3000, temperature=0
        )
        return (res.choices[0].message.content or "").strip()


def create_answer_generator() -> AnswerGenerator:
    provider = os.environ.get("ANSWER_PROVIDER", "stub")
    if provider == "workers_ai":
        # 既定を glm-4.7-flash にしない。ハンドブック §5.2 はこちらを指定しているが、
        # Cloudflare側のツール解析が壊れていて、ADMIN_TOOLS を渡すと tool_calls が
        # 空のまま生の記法が本文に漏れる(実機で18回中12回。gemma は0回)。
        # 管理者のフォルダ操作が全部黙って動かなくなるので gemma を既定にした。
        # 差し替えられるように env は残してある。
        # CF_VISION_MODEL 側も含め、モデルを変えるときはニューロン消費に注意
        # (書き起こし1ページ: gemma 7〜11 に対し qwen3.8-27b は125。無料枠は1日10,000)
        return WorkersAiAnswerGenerator(
            model=os.environ.get("CF_CHAT_MODEL", "@cf/google/gemma-4-26b-a4b-it"),
        )
    if provider == "bedrock":
        return BedrockAnswerGenerator(
            model_id=os.environ.get(
                "BEDROCK_CHAT_MODEL_ID",
                "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
            ),
            region=os.environ.get("AWS_REGION", "ap-northeast-1"),
        )
    return StubAnswerGenerator()
