import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  SupabaseAdminService,
  TEMPORARY_PASSWORD_LENGTH,
  generateTemporaryPassword,
  toAdminError,
  toAdminUserInfo,
} from './supabase';

/**
 * Supabase Authの利用者管理。
 *
 * ここを間違えると、切り替え当日に管理者が利用者を追加できない
 * (=誰もログインできない)か、配った仮パスワードで入れないかになる。
 * 特に次の3つを固定しておく:
 *   - 仮パスワードは自前で十分な強度で作る(admin APIは3文字でも通してしまう)
 *   - 「まだ一度もログインしていない」はlast_sign_in_atの有無で判定する
 *   - エラーの文言はCognito版と1文字も変えない(画面にそのまま出るため)
 */

describe('generateTemporaryPassword', () => {
  it('16文字で、大文字・小文字・数字・記号をすべて含む', () => {
    for (let i = 0; i < 50; i += 1) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!#%+=?@]/);
    }
  });

  it('見間違えやすい文字(I l 1 O o 0)は使わない', () => {
    // Teamsで配ったものを手で打ち直す人がいるため
    for (let i = 0; i < 50; i += 1) {
      expect(generateTemporaryPassword()).not.toMatch(/[IlO1o0]/);
    }
  });

  it('毎回ちがう(使い回さない)', () => {
    const made = new Set(
      Array.from({ length: 200 }, () => generateTemporaryPassword()),
    );
    expect(made.size).toBe(200);
  });

  it('先頭が必ず大文字…のような並びの偏りがない', () => {
    // 混ぜ忘れると先頭4文字が「大・小・数・記号」の順に固定される
    const heads = new Set(
      Array.from({ length: 100 }, () => generateTemporaryPassword()[0]),
    );
    expect(heads.size).toBeGreaterThan(5);
  });
});

describe('toAdminUserInfo', () => {
  it('一度もログインしていない人はpasswordPendingがtrue', () => {
    // 作成直後のレスポンスにはlast_sign_in_atが無い(実機で確認)
    const info = toAdminUserInfo({
      id: 'b3e1c0d2-0000-4000-8000-000000000001',
      email: 'zz-probe@example.com',
      created_at: '2026-09-09T18:10:00Z',
    });
    expect(info).toEqual({
      sub: 'b3e1c0d2-0000-4000-8000-000000000001',
      email: 'zz-probe@example.com',
      passwordPending: true,
      createdAt: new Date('2026-09-09T18:10:00Z'),
    });
  });

  it('ログイン済みならpasswordPendingがfalse', () => {
    const info = toAdminUserInfo({
      id: 'x',
      email: 'a@example.com',
      created_at: '2026-09-09T18:10:00Z',
      last_sign_in_at: '2026-09-09T18:19:33Z',
    });
    expect(info.passwordPending).toBe(false);
  });

  it('メールも作成日時も無い応答で落ちない', () => {
    expect(toAdminUserInfo({ id: 'x' })).toEqual({
      sub: 'x',
      email: null,
      passwordPending: true,
      createdAt: null,
    });
  });
});

describe('toAdminError', () => {
  it('重複しているメールアドレスはConflictException(文言はCognito版と同じ)', () => {
    // 実機で返ってきた本文をそのまま使う
    const error = toAdminError(422, {
      code: 422,
      error_code: 'email_exists',
      msg: 'A user with this email address has already been registered',
    });
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe('このメールアドレスは既に登録されています');
  });

  it('居ない利用者はNotFoundException(文言はCognito版と同じ)', () => {
    const error = toAdminError(404, {
      code: 404,
      error_code: 'user_not_found',
      msg: 'User not found',
    });
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toBe('ユーザーが見つかりません');
  });

  it('混み合っているとき(429)は待てば直ると分かる文言にする', () => {
    const error = toAdminError(429, { msg: 'Request rate limit reached' });
    expect(error.message).toMatch(/少し待ってから/);
    expect(error.message).toMatch(/429/);
  });

  it('知らないエラーはHTTPコードと本文を残す(原因が追えるように)', () => {
    const error = toAdminError(500, { msg: 'Internal Server Error' });
    expect(error.message).toMatch(/HTTP 500/);
    expect(error.message).toMatch(/Internal Server Error/);
  });

  it('JSONでない本文でも落ちない', () => {
    expect(toAdminError(502, '<html>bad gateway</html>').message).toMatch(
      /HTTP 502/,
    );
  });
});

describe('SupabaseAdminService.listUsers', () => {
  const realFetch = global.fetch;
  const realUrl = process.env.SUPABASE_URL;
  const realKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  /** ページ番号ごとに返す利用者を決めた偽のfetchを立てる */
  const stubPages = (pages: { id: string }[][]) => {
    const requested: string[] = [];
    global.fetch = ((input: unknown) => {
      const url = String(input);
      requested.push(url);
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      const users = pages[page - 1] ?? [];
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ users })),
      });
    }) as unknown as typeof fetch;
    return requested;
  };

  const manyUsers = (count: number, offset = 0) =>
    Array.from({ length: count }, (_, i) => ({ id: `u${offset + i}` }));

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env.SUPABASE_URL = realUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = realKey;
  });

  it('1ページで収まるなら2ページ目は取りに行かない', async () => {
    const requested = stubPages([manyUsers(8)]);
    const users = await new SupabaseAdminService().listUsers();
    expect(users).toHaveLength(8);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('per_page=100');
  });

  it('ちょうど1ページぶん返ったら次を見に行き、空で止まる', async () => {
    // per_page未満で終わりと判断するので、ちょうどの件数が一番危ない
    const requested = stubPages([manyUsers(100), []]);
    const users = await new SupabaseAdminService().listUsers();
    expect(users).toHaveLength(100);
    expect(requested).toHaveLength(2);
  });

  it('複数ページをつないで返す', async () => {
    stubPages([manyUsers(100), manyUsers(30, 100)]);
    const users = await new SupabaseAdminService().listUsers();
    expect(users).toHaveLength(130);
    expect(users[129].sub).toBe('u129');
  });

  it('URLか鍵が無ければ、何を設定すべきか分かる日本語で断る', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(new SupabaseAdminService().listUsers()).rejects.toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

/**
 * 200で返ってきた「形の違う応答」を0人として扱わないこと。
 *
 * res.users ?? [] にしていたときは、usersを持たない200(プロキシのHTML、
 * ログイン画面、形の変わったJSON)が全部「利用者0人」として成功で返っていた。
 * 管理画面には「誰も居ない」と出るが例外ではないので誰も気づけない。
 * この案件で実際に起きた「データが消えたように見える」状態そのものなので、
 * 「0人」と「読めなかった」は必ず分ける。
 */
describe('SupabaseAdminService.listUsers の応答の検証', () => {
  const realFetch = global.fetch;
  const realUrl = process.env.SUPABASE_URL;
  const realKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  /** 1回の応答だけを決めた偽のfetch */
  const stubBody = (body: string, status = 200) => {
    global.fetch = (() =>
      Promise.resolve({
        ok: status < 400,
        status,
        text: () => Promise.resolve(body),
      })) as unknown as typeof fetch;
  };

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env.SUPABASE_URL = realUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = realKey;
  });

  it('本当に0人のときは成功で空を返す', () => {
    stubBody(JSON.stringify({ users: [] }));
    return expect(new SupabaseAdminService().listUsers()).resolves.toEqual([]);
  });

  it('usersキーの無い200は「読めなかった」として例外にする', async () => {
    // 実測: 200 + {"aud":"authenticated"} が返ることがある
    stubBody(JSON.stringify({ aud: 'authenticated' }));
    await expect(new SupabaseAdminService().listUsers()).rejects.toThrow(
      InternalServerErrorException,
    );
    await expect(new SupabaseAdminService().listUsers()).rejects.toThrow(
      /想定外の応答/,
    );
  });

  it('HTMLが返る200(プロキシやログイン画面)も例外にする', async () => {
    stubBody('<html><body>Sign in</body></html>');
    await expect(new SupabaseAdminService().listUsers()).rejects.toThrow(
      /想定外の応答/,
    );
  });

  it('users が配列でない200も例外にする', async () => {
    stubBody(JSON.stringify({ users: null }));
    await expect(new SupabaseAdminService().listUsers()).rejects.toThrow(
      /想定外の応答/,
    );
  });
});

/**
 * admin APIの呼び出しに期限があること。
 *
 * 入れていなかったときは、応答を返さないスタブに対して listUsers() が
 * 302秒(undiciの既定300秒)生きていた。招待は最大30件を並行に投げるので、
 * ここで5分待たされると管理画面が固まる。
 */
describe('SupabaseAdminService のタイムアウト', () => {
  const realFetch = global.fetch;
  const realUrl = process.env.SUPABASE_URL;
  const realKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  /** fetchに渡された初期化オプションを覚えておく偽のfetch */
  const captureInit = () => {
    const seen: RequestInit[] = [];
    global.fetch = ((_input: unknown, init: RequestInit) => {
      seen.push(init);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ users: [] })),
      });
    }) as unknown as typeof fetch;
    return seen;
  };

  /** 失敗するはずの呼び出しから、投げられたエラーだけを取り出す */
  const failureOf = async (run: Promise<unknown>): Promise<Error> => {
    const success = Symbol('成功');
    const result = await run.then(
      () => success,
      (e: unknown) => e,
    );
    if (result === success) {
      throw new Error('失敗するはずの呼び出しが成功しました');
    }
    return result as Error;
  };

  /** タイムアウトでundiciが投げるのと同じ形のエラーを返す偽のfetch */
  const stubTimeout = () => {
    global.fetch = () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      return Promise.reject(e);
    };
  };

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env.SUPABASE_URL = realUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = realKey;
  });

  it('一覧の取得には中断用のsignalが必ず付く', async () => {
    const seen = captureInit();
    await new SupabaseAdminService().listUsers();
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    // まだ時間は経っていないので中断されていない
    expect(seen[0].signal?.aborted).toBe(false);
  });

  it('作成にも中断用のsignalが必ず付く', async () => {
    const seen = captureInit();
    await new SupabaseAdminService().createUser('a@example.com');
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('削除にも中断用のsignalが必ず付く', async () => {
    const seen = captureInit();
    await new SupabaseAdminService().deleteUser('sub-1');
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('一覧がタイムアウトしたら、何秒で諦めたかが分かる日本語で返す', async () => {
    stubTimeout();
    const failure = await failureOf(new SupabaseAdminService().listUsers());
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    // rag/service.ts と同じ言い回し。秒数まで出す
    expect(failure.message).toBe(
      'Supabaseの利用者管理に応答がありません(10秒でタイムアウト)',
    );
  });

  it('書き込み(作成)は一覧より長く待つ', async () => {
    stubTimeout();
    const failure = await failureOf(
      new SupabaseAdminService().createUser('a@example.com'),
    );
    expect(failure.message).toBe(
      'Supabaseの利用者管理に応答がありません(15秒でタイムアウト)',
    );
  });

  it('タイムアウト以外の通信断は今までどおりの文言のまま', async () => {
    global.fetch = () => Promise.reject(new Error('fetch failed'));
    const failure = await failureOf(new SupabaseAdminService().listUsers());
    expect(failure.message).toBe(
      'Supabaseの利用者管理に接続できませんでした: fetch failed',
    );
  });
});
