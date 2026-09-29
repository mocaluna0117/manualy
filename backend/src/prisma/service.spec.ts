import { PrismaService } from './service';

/**
 * TLSの検査は「DBに繋ぐ経路なら必ず通る」場所に置くこと。
 *
 * 以前は main.ts が最初にimportする config/load-secrets.ts に置いていた。
 * それでは main.ts から起動するサーバー本体しか守れず、src/scripts/ 配下
 * (migrate-user-ids など。切り替え当日に本番のSupabaseへ書き込む)は
 * PrismaService を直接組み立てるので素通りしていた。
 * Supabaseの接続文字列には sslmode が付いておらず、node-pg はそれを
 * そのまま読むため、CAを渡さないと**平文**で繋がる。動いてしまうぶん
 * 誰も気づけないので、組み立てた時点で止める。
 *
 * ただしAWS(RDS)とローカル開発を巻き添えにしないこと。
 * 9/16まではAWSが本番で、そちらは今までどおり動く必要がある。
 */
describe('PrismaService の起動時チェック', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('SupabaseにCAなしで繋ごうとしたら組み立てを止める', () => {
    process.env.DATABASE_URL =
      'postgresql://postgres.abc:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres';
    delete process.env.DATABASE_SSL_CA;

    // ここを通さないと、scripts から本番のSupabaseへ平文で繋がる
    expect(() => new PrismaService()).toThrow(/DATABASE_SSL_CA/);
  });

  it('CAを渡していれば通す(暗号化 + 証明書の検証で繋がる)', () => {
    process.env.DATABASE_URL =
      'postgresql://postgres.abc:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres';
    // イメージに同梱してあるものと同じCA(リポジトリにも置いてある)
    process.env.DATABASE_SSL_CA = 'certs/supabase-ca.crt';

    expect(() => new PrismaService()).not.toThrow();
  });

  it('AWS(RDS)は巻き添えにしない。切り替え日まではこちらが本番', () => {
    process.env.DATABASE_URL =
      'postgresql://app:pw@manualy.abcdef.ap-northeast-1.rds.amazonaws.com:5432/manualy';
    delete process.env.DATABASE_SSL_CA;

    expect(() => new PrismaService()).not.toThrow();
  });

  it('ローカル開発(TLSなしのDockerネットワーク)も通す', () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@db:5432/manual_search';
    delete process.env.DATABASE_SSL_CA;

    expect(() => new PrismaService()).not.toThrow();
  });

  it('DATABASE_URL が無ければ今までどおりそちらを先に言う', () => {
    delete process.env.DATABASE_URL;

    expect(() => new PrismaService()).toThrow(/DATABASE_URL/);
  });
});
