/**
 * DBへの接続が本当にTLSで検証されるかを、起動時に確かめる。
 *
 * Supabaseの証明書は公的CAではなく自前のCA(O=Supabase Inc /
 * CN=Supabase Intermediate 2021 CA)で署名されている。そのため
 * DATABASE_SSL_CA を渡さないと、
 *
 *   - node-pg(backend) … 接続文字列に sslmode が無いので **平文**で繋がる
 *     (Supabaseの Session pooler の接続文字列には sslmode が付いていない。
 *      実測: pg_stat_ssl.ssl = false)
 *   - psycopg(rag)     … sslmode 既定の prefer なので、暗号化はされても
 *     相手が本物かは確認しない(中間者攻撃を検知できない)
 *
 * のどちらも「繋がってしまう」。動いているように見えるので誰も気づかない。
 * CAはイメージに同梱してある(backend/Dockerfile の COPY certs/)ので、
 * 足りないのは環境変数だけ。起動を止めて、設定漏れをその場で気づかせる。
 *
 * AWS(RDS)側の経路は変えない。ECSのtaskdefは以前から
 * DATABASE_SSL_CA=/app/certs/rds-ca.pem を渡しているし、
 * ここで見るのは接続先がSupabaseのときだけなので、
 * 切り替え日までの本番と手元のローカル開発(TLSなし)は素通りする。
 */

/** イメージに同梱してあるSupabaseのCA(Dockerfileの COPY certs/ と対) */
export const SUPABASE_CA_PATH = '/app/certs/supabase-ca.crt';

/**
 * 自前のCAでないと検証できない接続先。
 *
 * db.<ref>.supabase.co(直結)と <region>.pooler.supabase.com(pooler)の
 * どちらも来るので、supabase のドメイン全体で見る
 */
const NEEDS_PRIVATE_CA = /(^|\.)supabase\.(co|com|net)$/i;

/**
 * 設定を見て、危ないなら理由を返す。問題なければ null。
 *
 * 環境変数を引数で受けるのは、テストから process.env を汚さずに
 * 確かめられるようにするため。
 */
export function checkDatabaseTls(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const url = env.DATABASE_URL;
  // 未設定は PrismaService 側が落とす。ここでは二重に言わない
  if (!url) return null;
  // CAを渡していれば「暗号化 + 証明書の検証」で繋がる
  if (env.DATABASE_SSL_CA) return null;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // 読めない形の接続文字列に口を出さない(判定を間違えて起動を
    // 止めるほうが害が大きい)
    return null;
  }
  if (!NEEDS_PRIVATE_CA.test(host)) return null;

  return (
    `DATABASE_URL が ${host} を指していますが DATABASE_SSL_CA が設定されていません。` +
    'Supabaseの証明書は自前のCAで署名されているため、このままでは' +
    '検証なし(node-pgでは平文)で繋がります。' +
    `イメージに同梱してあるCAを指すよう DATABASE_SSL_CA=${SUPABASE_CA_PATH} を設定してください`
  );
}
