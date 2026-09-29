"""Secret Managerからマウントしたひとまとまりの秘密を環境変数へ展開する。

Cloud Runで使うSecret Managerは無料枠が「有効なバージョン6個まで」しかない。
DATABASE_URL / R2の鍵 / CF_API_TOKEN / RAG_API_TOKEN … を1件ずつシークレットに
すると即座に超えるので、まとめて1つのJSONにして /etc/secrets/app.json へ
マウントし、起動時にここで展開する。

**必ずプロジェクト内の他のimportより前に読み込むこと。**
security.py も embedding.py も import された時点で os.environ を読むため、
後から環境変数を入れても遅い(main.py の1行目でimportしている)。

約束は3つだけ。マウントするJSONのキーは運用側で増減するので、
こちら側は特定のキー名を知らない汎用の実装にしてある。

1) ファイルが無ければ何もしない
   … ローカルとAWSは今までどおり環境変数だけで動く。
     「無ければ落とす」にすると切り替え日までAWSが起動しなくなる。
2) 既に入っている環境変数は上書きしない
   … デプロイ時に --set-env-vars で明示した値のほうが意図が新しい。
3) 読めたのに中身が壊れていたら起動を止める
   … 半端な設定で起動すると「動いているように見えて壊れている」状態になる。
"""

import json
import os

DEFAULT_SECRETS_FILE = "/etc/secrets/app.json"


def load(path: str | None = None) -> int:
    """秘密のJSONを読み、まだ無い環境変数だけを埋める。設定した件数を返す。"""
    target = path or os.environ.get("SECRETS_FILE") or DEFAULT_SECRETS_FILE
    try:
        with open(target, encoding="utf-8") as f:
            raw = f.read()
    except FileNotFoundError:
        # 無いのが正常な経路(ローカル/AWS)なので黙って戻る
        return 0
    except OSError as e:
        # 権限不足など「置いてあるのに読めない」のは設定ミスなので落とす
        raise RuntimeError(f"秘密ファイル {target} を読めません: {e}") from e

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"秘密ファイル {target} のJSONが壊れています") from e
    if not isinstance(parsed, dict):
        raise RuntimeError(
            f"秘密ファイル {target} はキーと値のオブジェクトである必要があります"
        )

    applied = 0
    for key, value in parsed.items():
        if key in os.environ:  # 2) 既に入っているものを優先
            continue
        # 環境変数は文字列しか持てない。数値と真偽値は文字列にし、
        # None は「未設定」と区別が付かないので飛ばす
        if isinstance(value, str):
            os.environ[key] = value
        elif isinstance(value, bool):
            # bool は int の下位型なので先に判定する。Pythonの "True" ではなく
            # JSONと同じ小文字にする(backend側の読み込みと表記を揃えるため)
            os.environ[key] = "true" if value else "false"
        elif isinstance(value, (int, float)):
            os.environ[key] = str(value)
        else:
            continue
        applied += 1
    return applied


# importしただけで読み込みが走るようにしておく。呼び出し忘れると
# security.py が空の設定を掴んだまま起動してしまうため
_applied = load()
if _applied > 0:
    # 値は絶対に出さない。何件入ったかだけ(マウント漏れの切り分け用)
    print(f"[secrets] {_applied}件の設定をマウントしたJSONから読み込みました")
