import type { PrismaService } from '../prisma/service';
import {
  DbReclassifyStore,
  MemoryReclassifyStore,
  createReclassifyStore,
  emptyReclassifyOutcome,
  type ReclassifyOutcome,
} from './reclassify-store';

/**
 * 全件再分類の進み具合の置き場所。
 *
 * ここで守りたいのは2つ。
 * 1) 1件も無くても値が返ること。管理者のサイドバーが30秒ごとに叩くので、
 *    nullや例外を返すとトーストが荒れ続ける(GraphQLの型もnon-null)。
 * 2) 終わったあとも結果が残ること。フロントは running が true→false に
 *    変わった「同じレスポンス」の件数を読んで通知を出すため、
 *    完了時に消す実装にすると通知が空になる。
 */

const outcome: ReclassifyOutcome = {
  ok: true,
  movedCount: 12,
  createdCategories: ['エアコン'],
  emptiedCategories: [{ id: 'c1', name: '旧・空調', createdByAi: true }],
  movedToLocked: ['見積書のひな形'],
  skippedLocked: ['社外秘の手順'],
  conflictedCount: 3,
};

describe('MemoryReclassifyStore', () => {
  it('1件も無ければ「動いていない」を値で返す', async () => {
    const store = new MemoryReclassifyStore();
    const status = await store.latest();

    expect(status.running).toBe(false);
    expect(status.movedCount).toBe(0);
    expect(status.createdCategories).toEqual([]);
    expect(status.emptiedCategories).toEqual([]);
    expect(status.error).toBeNull();
    expect(status.finishedAt).toBeNull();
  });

  it('開始すると実行中になる(二重起動の判定に使う)', async () => {
    const store = new MemoryReclassifyStore();
    await store.tryStart('家電ごとにまとめて');

    expect((await store.latest()).running).toBe(true);
    // 走っている間は次を始められない
    expect(await store.tryStart()).toBeNull();
  });

  it('開始時の指示と会話は実処理側から読める', async () => {
    const store = new MemoryReclassifyStore();
    const jobId = await store.tryStart('家電ごとに', 'conv-1');

    expect(await store.read(jobId!)).toEqual({
      instruction: '家電ごとに',
      conversationId: 'conv-1',
      running: true,
    });
    // 知らないIDには答えない(配り直された古いタスクを走らせないため)
    expect(await store.read('別のID')).toBeNull();
  });

  it('完了しても件数を消さない。消すとトーストが空になる', async () => {
    const store = new MemoryReclassifyStore();
    const jobId = await store.tryStart();
    await store.finish(jobId!, outcome);

    const status = await store.latest();
    expect(status.running).toBe(false);
    expect(status.movedCount).toBe(12);
    expect(status.createdCategories).toEqual(['エアコン']);
    expect(status.movedToLocked).toEqual(['見積書のひな形']);
    expect(status.skippedLocked).toEqual(['社外秘の手順']);
    expect(status.conflictedCount).toBe(3);
    expect(status.error).toBeNull();
    expect(status.finishedAt).toBeInstanceOf(Date);
    // 終わっていれば次を始められる
    expect(await store.tryStart()).not.toBeNull();
  });

  it('失敗したら理由を残す', async () => {
    const store = new MemoryReclassifyStore();
    const jobId = await store.tryStart();
    await store.finish(jobId!, {
      ...emptyReclassifyOutcome(),
      ok: false,
      error: 'AIが応答しませんでした',
    });

    expect((await store.latest()).error).toBe('AIが応答しませんでした');
  });
});

/** ReclassifyJob 表の代わり。最新1行だけを持つ */
function makePrisma(row: Record<string, unknown> | null) {
  const created: Record<string, unknown>[] = [];
  const updated: { id: string; data: Record<string, unknown> }[] = [];
  const locks: unknown[] = [];
  const queryRawCalls: unknown[] = [];
  const closedStale: Record<string, unknown>[] = [];
  const prisma: Record<string, unknown> = {
    // 開始の宣言はトランザクションの中で行う。ここでは同じモックを
    // そのまま渡し、助言ロックのSQLが流れたことだけ記録する
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    // 助言ロックは $executeRaw で流す約束。$queryRaw で流すと実DBでは
    // 必ず落ちるので、こちらが呼ばれたら記録して落ちる側に倒す
    $executeRaw: jest.fn((sql: unknown) => {
      locks.push(sql);
      return Promise.resolve(0);
    }),
    $queryRaw: jest.fn((sql: unknown) => {
      queryRawCalls.push(sql);
      // 実DBの再現。pg_advisory_xact_lock の戻り値は void なので、
      // Prismaは結果の列を型に直せずここで必ず例外になる
      return Promise.reject(
        new Error(
          "Raw query failed. Code: `N/A`. Message: `Failed to deserialize column of type 'void'.`",
        ),
      );
    }),
    reclassifyJob: {
      // latest() は条件なしで最新1行を読む。tryStart() は
      // 「実行中で、まだ見切っていない行があるか」を条件つきで読むので、
      // where が付いているときだけ絞り込みを真似る
      findFirst: jest.fn(
        (args?: { where?: { startedAt?: { gte?: Date } } }) => {
          if (!args?.where) return Promise.resolve(row);
          if (!row || row.running !== true) return Promise.resolve(null);
          const gte = args.where.startedAt?.gte;
          const fresh = !gte || (row.startedAt as Date) >= gte;
          return Promise.resolve(fresh ? row : null);
        },
      ),
      findUnique: jest.fn(() => Promise.resolve(row)),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: 'job-1' });
      }),
      update: jest.fn(
        (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updated.push({ id: args.where.id, data: args.data });
          return Promise.resolve({});
        },
      ),
      // 見切った行を閉じる更新。何を書き込んだかだけ控える
      updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
        closedStale.push(args.data);
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  return {
    prisma: prisma as unknown as PrismaService,
    created,
    updated,
    locks,
    queryRawCalls,
    closedStale,
  };
}

/** 表に入っている1行。JSON列は any 相当で返ってくる */
function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    running: false,
    movedCount: 12,
    createdCategories: ['エアコン'],
    emptiedCategories: [{ id: 'c1', name: '旧・空調', createdByAi: true }],
    movedToLocked: [],
    skippedLocked: [],
    conflictedCount: 0,
    instruction: null,
    conversationId: null,
    error: null,
    startedAt: new Date('2026-09-10T00:00:00Z'),
    finishedAt: new Date('2026-09-10T00:03:00Z'),
    ...over,
  };
}

describe('DbReclassifyStore', () => {
  it('1行も無ければ「動いていない」を値で返す(例外にしない)', async () => {
    const { prisma } = makePrisma(null);
    const status = await new DbReclassifyStore(prisma).latest();

    expect(status).toEqual({
      running: false,
      conflictedCount: 0,
      movedCount: 0,
      createdCategories: [],
      emptiedCategories: [],
      movedToLocked: [],
      skippedLocked: [],
      error: null,
      finishedAt: null,
    });
  });

  it('最新の1行を返す(開始した順の降順で1件だけ読む)', async () => {
    const { prisma } = makePrisma(makeRow());
    const store = new DbReclassifyStore(prisma);

    const status = await store.latest();

    expect(status.movedCount).toBe(12);
    expect(status.createdCategories).toEqual(['エアコン']);
    expect(status.emptiedCategories).toEqual([
      { id: 'c1', name: '旧・空調', createdByAi: true },
    ]);
    const findFirst = (
      prisma as unknown as { reclassifyJob: { findFirst: jest.Mock } }
    ).reclassifyJob.findFirst;
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { startedAt: 'desc' } }),
    );
  });

  it('JSON列が壊れていても画面を止めない', async () => {
    const { prisma } = makePrisma(
      makeRow({
        createdCategories: 'こわれている',
        emptiedCategories: [{ id: 'c1' }, null, 'x'],
      }),
    );
    const status = await new DbReclassifyStore(prisma).latest();

    expect(status.createdCategories).toEqual([]);
    // name の無い行は捨てる(画面が undefined を表示しないように)
    expect(status.emptiedCategories).toEqual([]);
  });

  it('実行中の行があれば running を返す', async () => {
    const { prisma } = makePrisma(
      makeRow({ running: true, startedAt: new Date(), finishedAt: null }),
    );
    const store = new DbReclassifyStore(prisma);

    expect((await store.latest()).running).toBe(true);
    // 走っている間は次を始められない
    expect(await store.tryStart()).toBeNull();
  });

  it('running のまま放置された古い行は、中断とみなして次を始められるようにする', async () => {
    // 途中でインスタンスが落ちると running=true のまま誰も終わらせない。
    // そのままだと二度と再分類できなくなる
    const { prisma } = makePrisma(
      makeRow({
        running: true,
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        finishedAt: null,
      }),
    );
    const store = new DbReclassifyStore(prisma);

    expect((await store.latest()).running).toBe(false);
    expect((await store.latest()).error).toMatch(/停止/);
    // 見切った古い行に塞がれず、次を始められる
    expect(await store.tryStart()).toBe('job-1');
  });

  it('開始すると実行中の行を作り、指示と会話を控える', async () => {
    const { prisma, created, locks } = makePrisma(null);
    const jobId = await new DbReclassifyStore(prisma).tryStart(
      '家電ごとに',
      'conv-1',
    );

    expect(jobId).toBe('job-1');
    expect(created[0]).toEqual({
      running: true,
      instruction: '家電ごとに',
      conversationId: 'conv-1',
    });
    // 判定と登録のあいだに割り込まれないよう、先に排他を取っている
    expect(locks).toHaveLength(1);
  });

  it('助言ロックは $executeRaw で流す($queryRaw だと必ず落ちる)', async () => {
    // pg_advisory_xact_lock の戻り値の型は void で、$queryRaw は返ってきた
    // 列を必ずPrismaの型へ直そうとするため
    // 「Failed to deserialize column of type 'void'」で **毎回** 失敗する。
    // 実DB(ビルド済みJS)で確認済み。tryStart が100%例外になり、
    // ReclassifyJob の行は1つもできず、画面には
    // 「再分類を開始できませんでした: Raw query failed...」が出ていた。
    // 二重起動を防ぐつもりの守りが「常に起動不可」に化けていたので、
    // ここで固定する
    const { prisma, created, locks, queryRawCalls } = makePrisma(null);

    await expect(new DbReclassifyStore(prisma).tryStart()).resolves.toBe(
      'job-1',
    );

    expect(locks).toHaveLength(1);
    expect(queryRawCalls).toHaveLength(0);
    expect(created).toHaveLength(1);
  });

  it('索引に弾かれたら「既に実行中」として null を返す(生のエラーを画面に出さない)', async () => {
    // アプリを経由しない挿入(psqlや別スクリプト)で running=true が
    // 先に入っていると、部分ユニーク索引 ReclassifyJob_running_key に
    // 弾かれる。呼び出し側(startReclassifyAll)はここを try で囲って
    // いないので、投げ返すとサイドバーにPrismaの生の文が出てしまう
    const { prisma } = makePrisma(null);
    (
      prisma as unknown as { reclassifyJob: { create: jest.Mock } }
    ).reclassifyJob.create = jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
        }),
      ),
    );

    await expect(new DbReclassifyStore(prisma).tryStart()).resolves.toBeNull();
  });

  it('索引以外の失敗は握りつぶさない(接続断を「実行中」と嘘をつかない)', async () => {
    const { prisma } = makePrisma(null);
    (
      prisma as unknown as { reclassifyJob: { create: jest.Mock } }
    ).reclassifyJob.create = jest.fn(() =>
      Promise.reject(new Error('接続プールが枯渇しました')),
    );

    await expect(new DbReclassifyStore(prisma).tryStart()).rejects.toThrow(
      /接続プール/,
    );
  });

  it('見切った行は次を作る前に閉じる(running=true を2行並べない)', async () => {
    // 部分ユニーク索引 ReclassifyJob_running_key があるので、
    // 古い running=true を残したまま新しい行を作ると挿入に失敗し、
    // 二度と再分類を始められなくなる
    const { prisma, created, closedStale } = makePrisma(
      makeRow({
        running: true,
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        finishedAt: null,
      }),
    );

    await expect(new DbReclassifyStore(prisma).tryStart()).resolves.toBe(
      'job-1',
    );

    expect(closedStale).toHaveLength(1);
    expect(closedStale[0]).toMatchObject({ running: false });
    expect(closedStale[0].error).toMatch(/停止/);
    expect(closedStale[0].finishedAt).toBeInstanceOf(Date);
    expect(created).toHaveLength(1);
  });

  it('完了を書き込む。件数は残し、finishedAt を入れる', async () => {
    const { prisma, updated } = makePrisma(makeRow());
    await new DbReclassifyStore(prisma).finish('job-1', outcome);

    expect(updated[0].id).toBe('job-1');
    expect(updated[0].data).toMatchObject({
      running: false,
      movedCount: 12,
      createdCategories: ['エアコン'],
      skippedLocked: ['社外秘の手順'],
      conflictedCount: 3,
      error: null,
    });
    expect(updated[0].data.finishedAt).toBeInstanceOf(Date);
  });
});

describe('createReclassifyStore', () => {
  const saved = process.env.RECLASSIFY_STORE;
  const savedDispatch = process.env.INGEST_DISPATCH;

  afterEach(() => {
    if (saved === undefined) delete process.env.RECLASSIFY_STORE;
    else process.env.RECLASSIFY_STORE = saved;
    if (savedDispatch === undefined) delete process.env.INGEST_DISPATCH;
    else process.env.INGEST_DISPATCH = savedDispatch;
  });

  it('既定はメモリ。AWS本番のRDSには ReclassifyJob 表がまだ無い', () => {
    delete process.env.RECLASSIFY_STORE;
    delete process.env.INGEST_DISPATCH;

    expect(createReclassifyStore({} as PrismaService)).toBeInstanceOf(
      MemoryReclassifyStore,
    );
  });

  it('裏処理をCloud Tasksへ投げる構成では表を使う(複数インスタンスになるため)', () => {
    delete process.env.RECLASSIFY_STORE;
    process.env.INGEST_DISPATCH = 'cloud_tasks';

    expect(createReclassifyStore({} as PrismaService)).toBeInstanceOf(
      DbReclassifyStore,
    );
  });

  it('明示した指定が優先される', () => {
    process.env.INGEST_DISPATCH = 'cloud_tasks';
    process.env.RECLASSIFY_STORE = 'memory';

    expect(createReclassifyStore({} as PrismaService)).toBeInstanceOf(
      MemoryReclassifyStore,
    );
  });
});
