import { SUPABASE_CA_PATH, checkDatabaseTls } from './db-tls';

/**
 * 「暗号化されているつもり」で平文のまま繋がるのを防ぐ。
 *
 * Supabaseの接続文字列(Session pooler)には sslmode が付いていない。
 * node-pg はそれをそのまま読むので、DATABASE_SSL_CA を渡さないと
 * 平文で繋がる(実機で pg_stat_ssl.ssl = false を確認)。
 * 動いてしまうぶん気づけないので、起動時に止める。
 *
 * ただしAWS(RDS)とローカル開発を巻き添えにしないこと。
 * 切り替え日までAWSが本番で、そちらは今までどおり動く必要がある。
 */
describe('checkDatabaseTls', () => {
  const supabase =
    'postgresql://postgres.abc:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres';

  it('SupabaseにCAなしで繋ごうとしたら理由を返す', () => {
    const problem = checkDatabaseTls({ DATABASE_URL: supabase });

    expect(problem).not.toBeNull();
    expect(problem).toContain('DATABASE_SSL_CA');
    // 直し方(同梱してあるCAの場所)まで書く
    expect(problem).toContain(SUPABASE_CA_PATH);
  });

  it('Supabaseの直結ホストも同じ(poolerだけの話ではない)', () => {
    expect(
      checkDatabaseTls({
        DATABASE_URL:
          'postgresql://postgres:pw@db.xscl.supabase.co:5432/postgres',
      }),
    ).not.toBeNull();
  });

  it('CAを渡していれば通す(検証つきで繋がる)', () => {
    expect(
      checkDatabaseTls({
        DATABASE_URL: supabase,
        DATABASE_SSL_CA: SUPABASE_CA_PATH,
      }),
    ).toBeNull();
  });

  it('AWS(RDS)は巻き添えにしない。切り替え日まではこちらが本番', () => {
    expect(
      checkDatabaseTls({
        DATABASE_URL:
          'postgresql://app:pw@manualy.abcdef.ap-northeast-1.rds.amazonaws.com:5432/manualy',
      }),
    ).toBeNull();
  });

  it('ローカル開発(TLSなしのDockerネットワーク)も通す', () => {
    expect(
      checkDatabaseTls({
        DATABASE_URL: 'postgresql://postgres:postgres@db:5432/manual_search',
      }),
    ).toBeNull();
  });

  it('未設定や読めない形の接続文字列には口を出さない', () => {
    expect(checkDatabaseTls({})).toBeNull();
    expect(
      checkDatabaseTls({ DATABASE_URL: 'これは接続文字列ではない' }),
    ).toBeNull();
  });
});
