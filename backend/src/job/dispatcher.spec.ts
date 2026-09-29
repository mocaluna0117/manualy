import { JobDispatcher, resolveDispatchMode } from './dispatcher';

/**
 * 応答を返したあとの処理をどこへ投げるか。
 *
 * ここで固定したいのは「切り替えても意味が変わらないこと」。
 * AWS(inline)は今までどおり同じプロセスで走り、Cloud Run では
 * Cloud Tasks に積む。設定を書き間違えたときは inline に倒れて、
 * 少なくとも取り込みが行方不明にはならない。
 */

/** テストごとに環境変数を元へ戻す(投げ先は環境変数だけで決まるため) */
const KEYS = [
  'INGEST_DISPATCH',
  'INTERNAL_BASE_URL',
  'INGEST_INTERNAL_TOKEN',
  'GCP_PROJECT_ID',
  'GCP_REGION',
  'GCP_TASKS_LOCATION',
  'GCP_TASKS_QUEUE',
  'GCP_TASKS_RECLASSIFY_QUEUE',
  'CLOUD_TASKS_DISPATCH_DEADLINE',
  // Cloud Run が必ず渡してくる印。設定漏れの検知に使うので毎回消しておく
  'K_SERVICE',
  'K_REVISION',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function makeDispatcher() {
  const dispatcher = new JobDispatcher();
  const handlers = {
    ingest: jest.fn(),
    reclassify: jest.fn(() => Promise.resolve()),
  };
  dispatcher.register(handlers);
  return { dispatcher, handlers };
}

/** fetchの1回目の呼び出し(URLと中身) */
function firstCall(fetchImpl: jest.Mock) {
  const [url, init] = fetchImpl.mock.calls[0] as [
    string,
    { method?: string; headers?: Record<string, string>; body?: string },
  ];
  return { url, init };
}

describe('resolveDispatchMode', () => {
  it('未設定なら inline(AWSとローカルの既定)', () => {
    expect(resolveDispatchMode(undefined)).toBe('inline');
  });

  it('知らない値は inline に倒す。黙って止まるより今までどおり動かす', () => {
    expect(resolveDispatchMode('cloudtasks')).toBe('inline');
    expect(resolveDispatchMode('')).toBe('inline');
  });

  it('決めた3つはそのまま通す', () => {
    expect(resolveDispatchMode('inline')).toBe('inline');
    expect(resolveDispatchMode('cloud_tasks')).toBe('cloud_tasks');
    expect(resolveDispatchMode('self_http')).toBe('self_http');
  });
});

describe('inline', () => {
  it('同じプロセスの実処理をそのまま呼ぶ(今までの挙動)', async () => {
    const { dispatcher, handlers } = makeDispatcher();
    const fetchImpl = jest.fn();
    dispatcher.fetchImpl = fetchImpl;

    await dispatcher.dispatchIngest('m1', true);

    expect(handlers.ingest).toHaveBeenCalledWith('m1', true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('再分類も同じプロセスで走らせる', async () => {
    const { dispatcher, handlers } = makeDispatcher();
    await dispatcher.dispatchReclassify('job-1');
    expect(handlers.reclassify).toHaveBeenCalledWith('job-1');
  });

  it('設定チェックは何も要求しない(AWSは環境変数を足さずに動く)', () => {
    const { dispatcher } = makeDispatcher();
    expect(() => dispatcher.verifyConfig()).not.toThrow();
  });
});

describe('cloud_tasks', () => {
  function setUp() {
    process.env.INGEST_DISPATCH = 'cloud_tasks';
    process.env.INTERNAL_BASE_URL = 'https://manualy-backend.example.run.app/';
    process.env.INGEST_INTERNAL_TOKEN = 'secret-token';
    process.env.GCP_PROJECT_ID = 'todoapp0117';
    process.env.GCP_REGION = 'us-west1';
    process.env.GCP_TASKS_QUEUE = 'manualy-ingest';
    const { dispatcher, handlers } = makeDispatcher();
    const fetchImpl = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{}'),
      }),
    );
    dispatcher.fetchImpl = fetchImpl;
    dispatcher.fetchAccessToken = jest.fn(() =>
      Promise.resolve({ token: 'ya29.test', expiresInSec: 3600 }),
    );
    return { dispatcher, handlers, fetchImpl };
  }

  it('キューのURLへ、Bearerトークン付きで積む', async () => {
    const { dispatcher, handlers, fetchImpl } = setUp();

    await dispatcher.dispatchIngest('m1', true);

    const { url, init } = firstCall(fetchImpl);
    expect(url).toBe(
      'https://cloudtasks.googleapis.com/v2/projects/todoapp0117' +
        '/locations/us-west1/queues/manualy-ingest/tasks',
    );
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBe('Bearer ya29.test');
    // 同じプロセスでは走らせない(応答後にCPUが止まるため)
    expect(handlers.ingest).not.toHaveBeenCalled();
  });

  it('宛先・トークン・本文(base64)・締切を組み立てる', async () => {
    const { dispatcher, fetchImpl } = setUp();

    await dispatcher.dispatchIngest('m1', true);

    const { init } = firstCall(fetchImpl);
    const task = (
      JSON.parse(init.body ?? '{}') as {
        task: {
          httpRequest: {
            url: string;
            headers: Record<string, string>;
            body: string;
          };
          dispatchDeadline: string;
          name?: string;
        };
      }
    ).task;
    // 末尾のスラッシュが二重にならないこと
    expect(task.httpRequest.url).toBe(
      'https://manualy-backend.example.run.app/internal/ingest',
    );
    expect(task.httpRequest.headers['X-Internal-Token']).toBe('secret-token');
    const payload = JSON.parse(
      Buffer.from(task.httpRequest.body, 'base64').toString('utf8'),
    ) as { manualId: string; autoCategorize: boolean; dispatchedAt: string };
    expect(payload.manualId).toBe('m1');
    expect(payload.autoCategorize).toBe(true);
    expect(Number.isNaN(Date.parse(payload.dispatchedAt))).toBe(false);
    // 上限は30分。これを超える値を送るとCloud Tasksが400を返す
    expect(task.dispatchDeadline).toBe('1800s');
    // 名前は付けない。付けると同じマニュアルの「再取り込み」が
    // 完了後しばらく409/404で黙って消える
    expect(task.name).toBeUndefined();
  });

  it('再分類は専用のキューに積める(取り込みの列で詰まらせない)', async () => {
    const { dispatcher, fetchImpl } = setUp();
    process.env.GCP_TASKS_RECLASSIFY_QUEUE = 'manualy-reclassify';

    await dispatcher.dispatchReclassify('job-1');

    expect(firstCall(fetchImpl).url).toContain('/queues/manualy-reclassify/');
  });

  it('専用キューの指定が無ければ取り込みと同じキューを使う', async () => {
    const { dispatcher, fetchImpl } = setUp();

    await dispatcher.dispatchReclassify('job-1');

    expect(firstCall(fetchImpl).url).toContain('/queues/manualy-ingest/');
  });

  it('トークンは期限まで使い回す(メタデータサーバを叩きすぎない)', async () => {
    const { dispatcher } = setUp();

    await dispatcher.dispatchIngest('m1', false);
    await dispatcher.dispatchIngest('m2', false);

    expect(dispatcher.fetchAccessToken).toHaveBeenCalledTimes(1);
  });

  it('積めなかったら例外にする(黙って握り潰さない)', async () => {
    const { dispatcher, fetchImpl } = setUp();
    fetchImpl.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('PERMISSION_DENIED'),
    });

    await expect(dispatcher.dispatchIngest('m1', false)).rejects.toThrow(/403/);
  });

  it('宛先URLが無いまま起動したら止める(取り込みが行方不明になるため)', () => {
    const { dispatcher } = setUp();
    delete process.env.INTERNAL_BASE_URL;

    expect(() => dispatcher.verifyConfig()).toThrow(/INTERNAL_BASE_URL/);
  });

  it('キュー名が無いまま起動したら止める', () => {
    const { dispatcher } = setUp();
    delete process.env.GCP_TASKS_QUEUE;

    expect(() => dispatcher.verifyConfig()).toThrow(/GCP_TASKS_QUEUE/);
  });
});

describe('self_http', () => {
  function setUp() {
    process.env.INGEST_DISPATCH = 'self_http';
    process.env.INTERNAL_BASE_URL = 'https://manualy-backend.example.run.app';
    process.env.INGEST_INTERNAL_TOKEN = 'secret-token';
    return makeDispatcher();
  }

  it('自分の内部エンドポイントへ、共有トークン付きでPOSTする', async () => {
    const { dispatcher } = setUp();
    const fetchImpl = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      }),
    );
    dispatcher.fetchImpl = fetchImpl;

    await dispatcher.dispatchIngest('m1', false);

    const { url, init } = firstCall(fetchImpl);
    expect(url).toBe('https://manualy-backend.example.run.app/internal/ingest');
    expect(init.headers?.['X-Internal-Token']).toBe('secret-token');
    expect(JSON.parse(init.body ?? '{}')).toMatchObject({
      manualId: 'm1',
      autoCategorize: false,
    });
  });

  it('応答は待たない。相手の処理は続くので、待ち時間を過ぎたら成功として返す', async () => {
    const { dispatcher } = setUp();
    // 相手が取り込みを続けていて、いつまでも返してこない状況
    dispatcher.fetchImpl = jest.fn(() => new Promise(() => undefined));
    dispatcher.selfHttpWaitMs = 10;

    await expect(
      dispatcher.dispatchIngest('m1', false),
    ).resolves.toBeUndefined();
  });

  it('既定の待ち時間は3秒(応答後にCPUが止まる前に送り切るため)', () => {
    expect(new JobDispatcher().selfHttpWaitMs).toBe(3_000);
  });

  it('待っている間に返ってきた失敗は伝える', async () => {
    const { dispatcher } = setUp();
    dispatcher.fetchImpl = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve(''),
      }),
    );

    await expect(dispatcher.dispatchIngest('m1', false)).rejects.toThrow(/401/);
  });

  it('トークンが無いまま起動したら止める', () => {
    const { dispatcher } = setUp();
    delete process.env.INGEST_INTERNAL_TOKEN;

    expect(() => dispatcher.verifyConfig()).toThrow(/INGEST_INTERNAL_TOKEN/);
  });
});

describe('メタデータサーバからのトークン取得', () => {
  it('Metadata-Flavor を付けて取り、access_token を使う', async () => {
    process.env.INGEST_DISPATCH = 'cloud_tasks';
    process.env.INTERNAL_BASE_URL = 'https://example.run.app';
    process.env.INGEST_INTERNAL_TOKEN = 't';
    process.env.GCP_PROJECT_ID = 'p';
    process.env.GCP_REGION = 'us-west1';
    process.env.GCP_TASKS_QUEUE = 'q';
    const { dispatcher } = makeDispatcher();
    const fetchImpl = jest.fn((url: string) =>
      Promise.resolve(
        url.includes('metadata.google.internal')
          ? {
              ok: true,
              status: 200,
              text: () =>
                Promise.resolve(
                  JSON.stringify({
                    access_token: 'ya29.meta',
                    expires_in: 3599,
                  }),
                ),
            }
          : { ok: true, status: 200, text: () => Promise.resolve('{}') },
      ),
    );
    dispatcher.fetchImpl = fetchImpl;

    await dispatcher.dispatchIngest('m1', false);

    const metadata = firstCall(fetchImpl);
    expect(metadata.url).toContain('metadata.google.internal');
    expect(metadata.init.headers?.['Metadata-Flavor']).toBe('Google');
    const [, task] = fetchImpl.mock.calls as unknown as [
      unknown,
      [string, { headers?: Record<string, string> }],
    ];
    expect(task[1].headers?.Authorization).toBe('Bearer ya29.meta');
  });
});

/**
 * Cloud Run 上で INGEST_DISPATCH を入れ忘れたときに気づけること。
 *
 * 未設定は inline に倒れるが、Cloud Run は応答を返した時点でCPUを止めるので
 * inline で始めた取り込みはその場で凍り、画面は永久に「取り込み中」になる。
 * 起動を止めればデプロイの時点で分かる。
 */
describe('Cloud Run での設定漏れ', () => {
  it('K_SERVICE があるのに INGEST_DISPATCH が無ければ起動を止める', () => {
    const { dispatcher } = makeDispatcher();
    process.env.K_SERVICE = 'manualy-backend';
    process.env.K_REVISION = 'manualy-backend-00007-abc';

    expect(dispatcher.mode).toBe('inline');
    expect(() => dispatcher.verifyConfig()).toThrow(/INGEST_DISPATCH/);
  });

  it('承知のうえで inline と明示していれば通す(逃げ道を塞がない)', () => {
    const { dispatcher } = makeDispatcher();
    process.env.K_SERVICE = 'manualy-backend';
    process.env.INGEST_DISPATCH = 'inline';

    expect(() => dispatcher.verifyConfig()).not.toThrow();
  });

  it('Cloud Run でなければ未設定のままでよい(AWSは今までどおり)', () => {
    const { dispatcher } = makeDispatcher();

    expect(() => dispatcher.verifyConfig()).not.toThrow();
  });

  it('綴り違いは黙って inline に倒さず、起動時に知らせる', () => {
    const { dispatcher } = makeDispatcher();
    process.env.INGEST_DISPATCH = 'cloudtasks';

    // 実行時の投げ先は今までどおり inline(黙って止めない)だが、
    // 起動時のチェックでは「書いてあるのに読めない」として弾く
    expect(dispatcher.mode).toBe('inline');
    expect(() => dispatcher.verifyConfig()).toThrow(/不明な値/);
  });
});
