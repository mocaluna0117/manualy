import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecretsFile } from './secrets';

/**
 * Secret Manager からマウントしたJSONの読み込み。
 *
 * Cloud Run の無料枠は「有効なバージョン6個まで」しかないので、秘密は
 * 1つのJSONにまとめて /etc/secrets/app.json に置く。
 *
 * ここで固定したいのは、切り替え日までAWSとローカルを壊さないこと。
 * ファイルが無いのが正常な経路なので、無ければ黙って何もしない。
 */

let dir: string;
const touched: string[] = [];

/** テストで入れた環境変数を片付ける */
function setEnv(key: string, value: string) {
  touched.push(key);
  process.env[key] = value;
}

function writeSecrets(content: string) {
  const path = join(dir, 'app.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'manualy-secrets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of touched.splice(0)) delete process.env[key];
});

describe('loadSecretsFile', () => {
  it('ファイルが無ければ何もしない(ローカルとAWSは環境変数のまま)', () => {
    expect(loadSecretsFile(join(dir, '存在しない.json'))).toBe(0);
  });

  it('未設定の環境変数を埋める', () => {
    touched.push('MANUALY_TEST_DB_URL', 'MANUALY_TEST_TOKEN');
    const path = writeSecrets(
      JSON.stringify({
        MANUALY_TEST_DB_URL: 'postgres://example',
        MANUALY_TEST_TOKEN: 'abc',
      }),
    );

    expect(loadSecretsFile(path)).toBe(2);
    expect(process.env.MANUALY_TEST_DB_URL).toBe('postgres://example');
    expect(process.env.MANUALY_TEST_TOKEN).toBe('abc');
  });

  it('既に入っている値は上書きしない(デプロイ時の指定を勝たせる)', () => {
    setEnv('MANUALY_TEST_DB_URL', 'postgres://いま動いているほう');
    const path = writeSecrets(
      JSON.stringify({ MANUALY_TEST_DB_URL: 'postgres://ふるいほう' }),
    );

    expect(loadSecretsFile(path)).toBe(0);
    expect(process.env.MANUALY_TEST_DB_URL).toBe(
      'postgres://いま動いているほう',
    );
  });

  it('数値と真偽値は文字列にして入れる。nullは未設定と区別が付かないので飛ばす', () => {
    touched.push('MANUALY_TEST_PORT', 'MANUALY_TEST_FLAG', 'MANUALY_TEST_NULL');
    const path = writeSecrets(
      JSON.stringify({
        MANUALY_TEST_PORT: 8080,
        MANUALY_TEST_FLAG: true,
        MANUALY_TEST_NULL: null,
      }),
    );

    expect(loadSecretsFile(path)).toBe(2);
    expect(process.env.MANUALY_TEST_PORT).toBe('8080');
    expect(process.env.MANUALY_TEST_FLAG).toBe('true');
    expect(process.env.MANUALY_TEST_NULL).toBeUndefined();
  });

  it('JSONが壊れていたら起動を止める(半端な設定で動かさない)', () => {
    const path = writeSecrets('{壊れている');

    expect(() => loadSecretsFile(path)).toThrow(/JSON/);
  });

  it('トップレベルがオブジェクトでなければ起動を止める', () => {
    const path = writeSecrets(JSON.stringify(['a', 'b']));

    expect(() => loadSecretsFile(path)).toThrow(/オブジェクト/);
  });
});

describe('読み込む順番', () => {
  it('main.ts の一番最初のimportであること', () => {
    // ここを入れ替えると静かに壊れる。PrismaService はコンストラクタで
    // DATABASE_SSL_CA を読むので、AppModule の解決より後に環境変数を
    // 入れても間に合わず、TLSの検証なしで繋ごうとして接続に失敗する
    const source = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    const imports = source
      .split('\n')
      .filter((line) => line.startsWith('import '));

    expect(imports[0]).toBe("import './config/load-secrets';");
  });
});
