import { ManualService } from './service';
import type { PrismaService } from '../prisma/service';
import type { JobDispatcher } from '../job/dispatcher';
import type { RagService } from '../rag/service';
import type { StorageService } from '../storage/service';

/**
 * 再分類を元に戻す処理。
 *
 * ここで一番大事なのは「戻しすぎない」こと。再分類のあとに人が手で
 * フォルダを移したものまで戻すと、その作業を黙って取り消すことになる。
 * 動かした先(after)から動いていないものだけを戻す、という約束を固定する。
 */

type Manual = { id: string; title: string; categoryId: string | null };
type Entry = { manualId: string; before: string | null; after: string | null };

function makeService(manuals: Manual[], snapshot: unknown) {
  const updates: { id: string; categoryId: string | null }[] = [];
  let undoneAt: Date | null = null;
  const prisma = {
    manual: {
      findMany: jest.fn((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(manuals.filter((m) => args.where.id.in.includes(m.id))),
      ),
      update: jest.fn(
        (args: {
          where: { id: string };
          data: { categoryId: string | null };
        }) => {
          const m = manuals.find((x) => x.id === args.where.id)!;
          m.categoryId = args.data.categoryId;
          updates.push({ id: args.where.id, categoryId: args.data.categoryId });
          return Promise.resolve(m);
        },
      ),
    },
    reclassifySnapshot: {
      findFirst: jest.fn(() => Promise.resolve(snapshot)),
      update: jest.fn((args: { data: { undoneAt: Date } }) => {
        undoneAt = args.data.undoneAt;
        return Promise.resolve({});
      }),
    },
  };
  const service = new ManualService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as RagService,
    // 裏処理の投げ先。ここで試すのは元に戻す処理だけなので使われない
    {} as JobDispatcher,
  );
  return { service, updates, undone: () => undoneAt };
}

const snapshotOf = (entries: Entry[], createdCategories: string[] = []) => ({
  id: 'snap-1',
  kind: 'ALL',
  entries,
  createdCategories,
  movedCount: entries.length,
  undoneAt: null,
  createdAt: new Date('2026-08-23T00:00:00Z'),
});

describe('undoLastReclassify', () => {
  it('AIが動かしたままのものを元の場所へ戻す', async () => {
    const manuals: Manual[] = [
      { id: 'm1', title: '顛末書', categoryId: 'new' },
      { id: 'm2', title: '手順書', categoryId: 'new' },
    ];
    const { service, updates } = makeService(
      manuals,
      snapshotOf([
        { manualId: 'm1', before: 'old', after: 'new' },
        { manualId: 'm2', before: null, after: 'new' },
      ]),
    );

    const result = await service.undoLastReclassify();

    expect(result.restoredCount).toBe(2);
    expect(updates).toEqual([
      { id: 'm1', categoryId: 'old' },
      { id: 'm2', categoryId: null }, // 元が未分類なら未分類に戻す
    ]);
  });

  it('再分類のあとに人が動かしたものは触らない', async () => {
    // AIは new へ動かしたが、そのあと人が hand へ移した
    const manuals: Manual[] = [
      { id: 'm1', title: '人が動かした資料', categoryId: 'hand' },
      { id: 'm2', title: 'そのままの資料', categoryId: 'new' },
    ];
    const { service, updates } = makeService(
      manuals,
      snapshotOf([
        { manualId: 'm1', before: 'old', after: 'new' },
        { manualId: 'm2', before: 'old', after: 'new' },
      ]),
    );

    const result = await service.undoLastReclassify();

    expect(updates).toEqual([{ id: 'm2', categoryId: 'old' }]);
    expect(result.restoredCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped).toEqual(['人が動かした資料']);
  });

  it('消されたマニュアルは黙って飛ばす', async () => {
    const { service, updates } = makeService(
      [], // 見つからない
      snapshotOf([{ manualId: 'm1', before: 'old', after: 'new' }]),
    );

    const result = await service.undoLastReclassify();

    expect(updates).toEqual([]);
    expect(result.restoredCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });

  it('すでに元の場所にあるものは動かさない', async () => {
    const { service, updates } = makeService(
      [{ id: 'm1', title: '手順書', categoryId: 'old' }],
      snapshotOf([{ manualId: 'm1', before: 'old', after: 'old' }]),
    );

    await service.undoLastReclassify();

    expect(updates).toEqual([]);
  });

  it('戻したら、その控えは使用済みにする(二重に戻さない)', async () => {
    const { service, undone } = makeService(
      [{ id: 'm1', title: '手順書', categoryId: 'new' }],
      snapshotOf([{ manualId: 'm1', before: 'old', after: 'new' }]),
    );

    await service.undoLastReclassify();

    expect(undone()).toBeInstanceOf(Date);
  });

  it('空になるフォルダを呼び出し側へ伝える', async () => {
    const { service } = makeService(
      [{ id: 'm1', title: '手順書', categoryId: 'new' }],
      snapshotOf(
        [{ manualId: 'm1', before: 'old', after: 'new' }],
        ['新設フォルダ'],
      ),
    );

    const result = await service.undoLastReclassify();

    expect(result.createdCategories).toEqual(['新設フォルダ']);
  });

  it('戻せる控えが無ければエラーにする', async () => {
    const { service } = makeService([], null);
    await expect(service.undoLastReclassify()).rejects.toThrow(
      '元に戻せる再分類がありません',
    );
  });
});

describe('lastReclassify', () => {
  it('まだ戻していない控えを返す', async () => {
    const { service } = makeService(
      [],
      snapshotOf([{ manualId: 'm1', before: null, after: 'new' }], ['新設']),
    );
    const last = await service.lastReclassify();
    expect(last).toMatchObject({ kind: 'ALL', movedCount: 1 });
    expect(last?.createdCategories).toEqual(['新設']);
  });

  it('無ければnullを返す', async () => {
    const { service } = makeService([], null);
    expect(await service.lastReclassify()).toBeNull();
  });
});
