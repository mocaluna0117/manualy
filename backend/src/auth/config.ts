/**
 * JWTの検証条件(発行元・宛先・署名方式・鍵の取得先)を環境変数から決める。
 *
 * strategy.tsにCognitoのURLの形を直書きしていたが、Supabase Authへ切り替える
 * にあたって外に出した。純粋関数にしてあるのは「AUTH_*を1つも設定しなければ
 * 今のCognitoと1バイトも変わらない」ことをテストで錠前として固定するため。
 * 切り替え日までAWS版が本番として動き続けるので、ここを壊すと当日を待たずに
 * 全員がログインできなくなる。
 */

/**
 * 受け付ける署名方式。JWKSで公開鍵を配る方式だけを並べ、共有秘密が要る
 * HS*とnoneは最初から入れない。AUTH_ALGORITHMSは運用中に書き換わりうる
 * 値なので、ここに無い名前は黙って捨てる(綴り間違いで検証が緩むより、
 * 既定に落ちて動き続ける方が安全)
 */
const SUPPORTED_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
] as const;

export type AuthAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];

export interface AuthConfig {
  /** トークンのissと完全一致で照合する値 */
  issuer: string;
  /** トークンのaudと照合する値。undefinedならaudを検証しない */
  audience: string | undefined;
  /** 署名の公開鍵を取りに行く先 */
  jwksUri: string;
  algorithms: AuthAlgorithm[];
}

/**
 * Cognito以外の発行元に切り替えたときの既定の署名方式。
 *
 * ES256だけにしないのは、AUTH_ISSUERを設定してAUTH_ALGORITHMSを忘れる、
 * あるいは逆に戻すときにこの値を戻し忘れる、のどちらでも全員が
 * `invalid algorithm`で401になるため(画面には「マニュアル0件・管理者でもない」
 * と出るので、データが消えたように見える)。
 *
 * 両方書いても危なくないことは実機で確かめた: 鍵はトークンのkidで選ばれ、
 * SupabaseのJWKSはEC鍵1本しか返さない。EC鍵でRS256の署名を検証することは
 * できないので、「RSAの鍵をES256として使う」ようなすり替えは起きない。
 */
const DEFAULT_ALGORITHMS: AuthAlgorithm[] = ['RS256', 'ES256'];

const trimmed = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v ? v : undefined;
};

/** 末尾のスラッシュを落とす(URLを継ぎ足すときの二重スラッシュ避け) */
const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * AUTH_ALGORITHMSの解釈。カンマ区切り・前後の空白・小文字を許す。
 * 知らない名前を全部捨てた結果が空になったら、空の許可リストで全員を
 * 締め出すより既定へ落とす方が被害が小さいのでundefinedを返す
 */
function parseAlgorithms(raw: string | undefined): AuthAlgorithm[] | undefined {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is AuthAlgorithm =>
      (SUPPORTED_ALGORITHMS as readonly string[]).includes(s),
    );
  return names.length > 0 ? names : undefined;
}

/**
 * 発行元を決める。ここがundefinedを返したときだけ今までのCognitoになる。
 *
 * AUTH_PROVIDER=supabaseのときにSUPABASE_URLから組み立てるのは、
 * 設定し忘れを1つ減らすため。SUPABASE_URLは利用者管理でどのみち要るので、
 * 「AUTH_PROVIDERは切り替えたがAUTH_ISSUERを忘れて全員401」が起きなくなる。
 * 実物のトークンのissが `${SUPABASE_URL}/auth/v1` であることは確認済み
 */
function resolveIssuer(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = trimmed(env.AUTH_ISSUER);
  if (explicit) return explicit;

  if (trimmed(env.AUTH_PROVIDER)?.toLowerCase() === 'supabase') {
    const base = trimmed(env.SUPABASE_URL);
    if (!base) {
      // 黙ってCognitoに落とすと、起動はするのに誰もログインできない状態に
      // なる。起動時に止めて理由を出す方が切り分けが早い
      throw new Error(
        'AUTH_PROVIDER=supabase のときは SUPABASE_URL か AUTH_ISSUER が必要です',
      );
    }
    return `${withoutTrailingSlash(base)}/auth/v1`;
  }
  return undefined;
}

export function resolveAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const issuer = resolveIssuer(env);

  if (!issuer) {
    // ---- 既定: 今のCognito。AUTH_*を設定しなければ必ずここに来る ----
    const region = env.COGNITO_REGION ?? 'ap-northeast-1';
    const userPoolId = env.COGNITO_USER_POOL_ID ?? '';
    const cognitoIssuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    return {
      issuer: cognitoIssuer,
      audience: env.COGNITO_CLIENT_ID,
      jwksUri: `${cognitoIssuer}/.well-known/jwks.json`,
      algorithms: ['RS256'],
    };
  }

  return {
    issuer,
    // COGNITO_CLIENT_IDへは落とさない。落とすとSupabaseのトークン
    // (audは全員 "authenticated" 固定)が全部 `jwt audience invalid` で
    // 弾かれる。audを検証しなくても、issとJWKSの署名で発行元は確定している
    audience: trimmed(env.AUTH_AUDIENCE),
    jwksUri:
      trimmed(env.AUTH_JWKS_URI) ??
      `${withoutTrailingSlash(issuer)}/.well-known/jwks.json`,
    algorithms: parseAlgorithms(env.AUTH_ALGORITHMS) ?? DEFAULT_ALGORITHMS,
  };
}
