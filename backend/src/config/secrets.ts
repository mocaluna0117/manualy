import { readFileSync } from 'node:fs';

/**
 * Secret Manager からマウントしたJSONを環境変数として読み込む。
 *
 * Cloud Run の Secret Manager は無料枠が「有効なバージョン6個まで」しかない。
 * 秘密を1件1シークレットにすると DATABASE_URL / R2の鍵 / CF_API_TOKEN /
 * RAG_API_TOKEN … だけで即座に超えるため、まとめて1つのJSONにして
 * /etc/secrets/app.json へマウントし、起動時にここで展開する。
 *
 * 設計の約束は3つだけにしてある。マウントされるJSONの中身(キー名)は
 * 運用側で増減するので、こちら側は特定のキーを知らない汎用のローダにする。
 *
 * 1) ファイルが無ければ何もしない
 *    … ローカル開発とAWS本番は今までどおり環境変数だけで動く。
 *      「無ければ落とす」にすると切り替え日までAWSが起動しなくなる。
 * 2) 既に process.env にある値は上書きしない
 *    … デプロイ時に --set-env-vars で明示した値のほうが意図が新しい。
 *      シークレット側の古い値で黙って上書きされると原因を追えない。
 * 3) 読めたのに中身が壊れている場合は起動を止める
 *    … 半端な設定のまま起動すると、DBだけ繋がって鍵が空、のような
 *      「動いているように見えて壊れている」状態になる。落ちれば気づく。
 */
export const DEFAULT_SECRETS_FILE = '/etc/secrets/app.json';

/**
 * 秘密のJSONを読み、まだ設定されていない環境変数だけを埋める。
 * 戻り値は実際に設定したキーの数(ログ用。値は出さない)。
 */
export function loadSecretsFile(
  path = process.env.SECRETS_FILE ?? DEFAULT_SECRETS_FILE,
): number {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    // 無いのが正常な経路(ローカル/AWS)なので黙って戻る。
    // 権限不足など「置いてあるのに読めない」場合は設定ミスなので落とす
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new Error(`秘密ファイル ${path} を読めません: ${String(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`秘密ファイル ${path} のJSONが壊れています`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `秘密ファイル ${path} はキーと値のオブジェクトである必要があります`,
    );
  }

  let applied = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined) continue; // 2) 既存を優先
    // 環境変数は文字列しか持てない。数値・真偽値はそのまま文字列にし、
    // null は「未設定」と区別が付かないので飛ばす。入れ子は使わない想定
    if (typeof value === 'string') process.env[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') {
      process.env[key] = String(value);
    } else continue;
    applied++;
  }
  return applied;
}
