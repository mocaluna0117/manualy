import type { JobDispatcher } from '../job/dispatcher';
import type { PrismaService } from '../prisma/service';
import type { RagService } from '../rag/service';
import type { StorageService } from '../storage/service';
import { ManualService } from './service';

/**
 * 全件再分類の「開始」と「進み具合の読み取り」。
 *
 * どちらも管理者のサイドバーが直接見ているので、値を取り違えると
 * 画面が嘘をつく。ここで固定するのは2つ。
 *
 * 1) 開始は1文で宣言する。判定と登録を分けると、DB往復の隙間で
 *    両方が「空いている」と読み、再分類が二重に走る。控え
 *    (ReclassifySnapshot)も2つできるので「元に戻す」が当てにならなくなる。
 * 2) 進み具合を読めなかったことを「何も起きていない」と混同しない。
 *    emptyReclassifyStatus() をそのまま返すと running が true→false に
 *    見え、フロントが「再分類が完了しました(0件)」を出してしまう。
 */

const OLD_STORE = process.env.RECLASSIFY_STORE;

beforeEach(() => {
  // ReclassifyJob 表を使う構成(Cloud Run)で確かめる
  process.env.RECLASSIFY_STORE = 'db';
});

afterEach(() => {
  if (OLD_STORE === undefined) delete process.env.RECLASSIFY_STORE;
  else process.env.RECLASSIFY_STORE = OLD_STORE;
});

/** オレゴンとのDB往復を真似た偽の ReclassifyJob 表 */
function makeService(roundTripMs = 5) {
  const rows: { id: string; running: boolean; startedAt: Date }[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let inTransaction = false;
  const prisma: Record<string, unknown> = {
    // 助言ロックの代わり。1つのトランザクションが終わるまで次を待たせる
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      while (inTransaction) await sleep(1);
      inTransaction = true;
      try {
        return await fn(prisma);
      } finally {
        inTransaction = false;
      }
    },
    // 助言ロックは $executeRaw で流す(void を返すSQLなので $queryRaw だと
    // Prismaが結果の列を型に直せず必ず落ちる)
    $executeRaw: jest.fn(() => Promise.resolve(0)),
    reclassifyJob: {
      // 見切った行を閉じる更新。ここでは古い行を作らないので何もしない
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      findFirst: jest.fn(async (args?: { where?: unknown }) => {
        await sleep(roundTripMs);
        const running = rows.find((r) => r.running);
        if (args?.where) return running ?? null;
        return (
          [...rows].sort(
            (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
          )[0] ?? null
        );
      }),
      create: jest.fn(async () => {
        await sleep(roundTripMs);
        const row = {
          id: `job-${rows.length + 1}`,
          running: true,
          startedAt: new Date(),
        };
        rows.push(row);
        return row;
      }),
    },
  };
  const dispatchReclassify = jest.fn(() => Promise.resolve());
  const service = new ManualService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as RagService,
    { dispatchReclassify, mode: 'cloud_tasks' } as unknown as JobDispatcher,
  );
  return { service, rows, dispatchReclassify };
}

describe('startReclassifyAll', () => {
  it('同時に2回呼ばれてもジョブは1つしかできない', async () => {
    const { service, rows, dispatchReclassify } = makeService();

    const [a, b] = await Promise.all([
      service.startReclassifyAll(),
      service.startReclassifyAll(),
    ]);

    // 片方だけが true。false は画面の「既に実行中です」に使われる
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(dispatchReclassify).toHaveBeenCalledTimes(1);
  });

  it('走っていなければ開始できる', async () => {
    const { service, rows } = makeService();

    await expect(service.startReclassifyAll('家電ごとに')).resolves.toBe(true);
    expect(rows).toHaveLength(1);
  });
});

describe('reclassifyStatusView', () => {
  function makeFailing(latest: () => Promise<unknown>) {
    const prisma = {
      reclassifyJob: { findFirst: jest.fn(latest) },
      manualCategory: { findMany: jest.fn(() => Promise.resolve([])) },
      manual: { groupBy: jest.fn(() => Promise.resolve([])) },
    };
    return new ManualService(
      prisma as unknown as PrismaService,
      {} as StorageService,
      {} as RagService,
      {} as JobDispatcher,
    );
  }

  it('読めなかったときに「完了・0件・エラー無し」を返さない', async () => {
    const service = makeFailing(() =>
      Promise.reject(new Error('接続プールが枯渇しました')),
    );

    const view = await service.reclassifyStatusView();

    // error が null のまま running=false を返すと、フロントは
    // 「再分類が完了しました(0件を割り当て)」を出してしまう
    expect(view.error).not.toBeNull();
    expect(view.error).toMatch(/読み取れませんでした/);
  });

  it('一度読めていれば、読めなくなっても直前の値を返す(進捗表示を消さない)', async () => {
    let fail = false;
    const service = makeFailing(() =>
      fail
        ? Promise.reject(new Error('接続プールが枯渇しました'))
        : Promise.resolve({
            id: 'job-1',
            running: true,
            movedCount: 0,
            createdCategories: [],
            emptiedCategories: [],
            movedToLocked: [],
            skippedLocked: [],
            conflictedCount: 0,
            error: null,
            startedAt: new Date(),
            finishedAt: null,
          }),
    );

    expect((await service.reclassifyStatusView()).running).toBe(true);
    fail = true;

    // 実行中のまま返す。false に倒すと、まだ走っているのに
    // 「完了しました」が出て、本当に終わったときには何も出ない
    expect((await service.reclassifyStatusView()).running).toBe(true);
  });
});
