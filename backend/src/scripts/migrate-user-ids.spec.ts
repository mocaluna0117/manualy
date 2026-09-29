import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../prisma/service';
import type { DbUserRow } from '../user/migrate-user-ids';
import type { SupabaseAdminService } from '../user/supabase';
import { main, run } from './migrate-user-ids';

/**
 * 移行スクリプトの本体(run)。
 *
 * 一番危ないのは「DBを書き換えてはいけない状態なのに、認証側にだけ
 * アカウントを作ってしまう」こと。作ったアカウントは自動では消えず、
 * 仮パスワードも標準出力に出たあとなので、当日に後始末が要る。
 * blockers を見るのが作成ループより後だったときに実際にそうなっていた。
 */
describe('migrate-user-ids の run()', () => {
  const admin = {
    id: 'db-1',
    email: 'kimura@example.com',
    cognitoSub: 'cognito-1',
    role: 'ADMIN',
  };

  /** DBは findMany だけ、書き込みは $transaction だけを見る偽物 */
  const fakePrisma = (dbUsers: DbUserRow[]) => {
    const transactions: unknown[][] = [];
    const prisma = {
      user: {
        findMany: () => Promise.resolve(dbUsers),
        update: (args: unknown) => args,
      },
      $transaction: (ops: unknown[]) => {
        transactions.push(ops);
        return Promise.resolve([]);
      },
    } as unknown as PrismaService;
    return { prisma, transactions };
  };

  /** 認証側。作成された宛先を記録する */
  const fakeAdmin = (users: { sub: string; email: string }[] = []) => {
    const created: string[] = [];
    const service = {
      listUsers: () =>
        Promise.resolve(
          users.map((u) => ({
            sub: u.sub,
            email: u.email,
            passwordPending: true,
            createdAt: null,
          })),
        ),
      createUser: (email: string) => {
        created.push(email);
        users.push({ sub: `supabase-${created.length}`, email });
        return Promise.resolve({
          sub: `supabase-${created.length}`,
          email,
          passwordPending: true,
          createdAt: null,
          temporaryPassword: 'Dummy#Password9',
        });
      },
      deleteUser: () => Promise.resolve(),
    } as unknown as SupabaseAdminService;
    return { service, created };
  };

  // 表と中止メッセージは人が読むためのものなので、テストでは黙らせる
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('blockersがあるときは、認証側に1件も作らずに中断する', async () => {
    // 大文字小文字だけ違う同じメールが2行(db-duplicate-email)。
    // 直す前はここで1人目を実際に作り、2人目でemail_existsになっていた
    const { prisma, transactions } = fakePrisma([
      admin,
      { id: 'db-2', email: 'Kimura@example.com', cognitoSub: 'cognito-2' },
    ]);
    const { service, created } = fakeAdmin();

    const code = await run(
      prisma,
      service,
      { apply: true, createMissing: true, savePath: undefined },
      'https://example.supabase.co/auth/v1',
    );

    expect(code).toBe(1);
    expect(created).toEqual([]); // 認証側に触っていない
    expect(transactions).toEqual([]); // DBにも書いていない
  });

  it('blockersが無ければ、足りない人を作ってから付け替える', async () => {
    const { prisma, transactions } = fakePrisma([admin]);
    const { service, created } = fakeAdmin();

    const code = await run(
      prisma,
      service,
      { apply: true, createMissing: true, savePath: undefined },
      'https://example.supabase.co/auth/v1',
    );

    expect(code).toBe(0);
    expect(created).toEqual(['kimura@example.com']);
    // 作った直後に一覧を取り直して、その新しいIDへ1件付け替える
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toHaveLength(1);
  });

  it('下見(--applyなし)なら、認証側にもDBにも触らない', async () => {
    const { prisma, transactions } = fakePrisma([admin]);
    const { service, created } = fakeAdmin();

    const code = await run(
      prisma,
      service,
      { apply: false, createMissing: true, savePath: undefined },
      'https://example.supabase.co/auth/v1',
    );

    expect(code).toBe(0);
    expect(created).toEqual([]);
    expect(transactions).toEqual([]);
  });
});

/**
 * 錠前を「実際に呼んでいるか」。
 *
 * decideAbort 自体は user/migrate-user-ids.spec.ts で固定してあるが、
 * それを main() が呼んでいなければ何も守っていない。実際、錠前のブロックを
 * main() から丸ごと消しても254件すべて緑のままだった。
 *
 * 見るのは「Nestを起こす前に1で戻ったか」。DIを起こしてしまうと
 * PrismaService が実際に接続しにいくので、起動そのものを偽物に差し替えて
 * 「呼ばれていないこと」を直接確かめる(呼ばれたらテストは落ちる)。
 *
 * 中止する側だけを並べても足りない。main() の頭に return 1 を置いた退化版で
 * 全部緑になることを実演したので、「環境が正しければ錠前を通り抜ける」側も
 * 一緒に固定する(最後のit)。
 */
describe('migrate-user-ids の main() が錠前を通っていること', () => {
  const savedArgv = process.argv;
  const savedEnv = { ...process.env };
  let bootstrap: jest.SpyInstance;
  /** 「通った側の1行」を後から読むために、logの中身も残す */
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) =>
        logged.push(args.map((a) => String(a)).join(' ')),
      );
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // 錠前が外れたときに本物のDBへ行かせない。ここが呼ばれること自体が失敗
    bootstrap = jest
      .spyOn(NestFactory, 'createApplicationContext')
      .mockRejectedValue(new Error('錠前を通り抜けてDBに繋ごうとしました'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.argv = savedArgv;
    process.env = { ...savedEnv };
  });

  it('DATABASE_URL が無ければ、DBに繋ぎにいく前に1で戻る', async () => {
    process.argv = ['node', 'migrate-user-ids.js', '--create-missing'];
    delete process.env.DATABASE_URL;

    await expect(main()).resolves.toBe(1);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('--apply で書き込み先がSupabaseと違えば、DBに繋ぎにいく前に1で戻る', async () => {
    process.argv = [
      'node',
      'migrate-user-ids.js',
      '--apply',
      '--save',
      '/tmp/does-not-matter.json',
    ];
    // AUTH_PROVIDER は通しておく。守っているのがDBの向き先だと分かるように
    process.env.AUTH_PROVIDER = 'supabase';
    process.env.DATABASE_URL =
      'postgresql://manual:pw@manual-search.abcdefgh.ap-northeast-1.rds.amazonaws.com:5432/manual_search';
    process.env.SUPABASE_DB_URL =
      'postgresql://postgres.abcdefgh:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres';

    await expect(main()).resolves.toBe(1);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('--apply で AUTH_PROVIDER が supabase でなければ、DBに繋ぎにいく前に1で戻る', async () => {
    process.argv = [
      'node',
      'migrate-user-ids.js',
      '--apply',
      '--save',
      '/tmp/does-not-matter.json',
    ];
    delete process.env.AUTH_PROVIDER;
    process.env.DATABASE_URL =
      'postgresql://postgres.abcdefgh:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres';
    process.env.SUPABASE_DB_URL = process.env.DATABASE_URL;

    await expect(main()).resolves.toBe(1);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('環境が正しければ、錠前を通り抜けてDBに繋ぎにいく', async () => {
    // 中止する側だけを固定しても配線を見たことにはならない。main() の頭に
    // return 1 を置いた退化版でも、上の3件は緑のままだった。
    // 「正しい環境なら通る」をここで押さえて、はじめて錠前の位置が決まる
    const savePath = join(
      tmpdir(),
      `migrate-user-ids-${process.pid}-${Date.now()}.json`,
    );
    const closed: number[] = [];
    // 錠前を抜けた先は偽のDIコンテナで受ける(本物のDBには繋がない)
    bootstrap.mockResolvedValue({
      get: (token: unknown) =>
        token === PrismaService
          ? { user: { findMany: () => Promise.resolve([]) } }
          : { listUsers: () => Promise.resolve([]) },
      close: () => {
        closed.push(1);
        return Promise.resolve();
      },
    });

    process.argv = [
      'node',
      'migrate-user-ids.js',
      '--apply',
      '--save',
      savePath,
    ];
    process.env.AUTH_PROVIDER = 'supabase';
    // ホストは同じでポート・利用者名・DB名だけ違う。錠前が見るのはホスト
    process.env.DATABASE_URL =
      'postgresql://postgres.abcdefgh:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres';
    process.env.SUPABASE_DB_URL =
      'postgresql://postgres.abcdefgh:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres';

    try {
      await expect(main()).resolves.toBe(0);
      // 錠前で止まらず、DIまで進んで後片付けもしている
      expect(bootstrap).toHaveBeenCalledTimes(1);
      expect(closed).toEqual([1]);
      // 通ったことも当日の目視の材料になる。証拠の1行が消えたら気づけない
      expect(logged.join('\n')).toContain(
        'は SUPABASE_DB_URL と一致しています',
      );
      // 付け替える行が0件なので控えは書かない(空ファイルを残さない)
      expect(existsSync(savePath)).toBe(false);
    } finally {
      if (existsSync(savePath)) unlinkSync(savePath);
    }
  });
});
