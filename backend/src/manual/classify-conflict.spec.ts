import { ManualService } from './service';
import type { PrismaService } from '../prisma/service';
import type { JobDispatcher } from '../job/dispatcher';
import type { RagService } from '../rag/service';
import type { StorageService } from '../storage/service';

/**
 * 分類ルールが食い違ったときの保留と、その解決。
 *
 * 大事なのは「勝手に動かさないこと」。どちらのルールが正しいかは運用の判断で、
 * AIに決めさせると意図しないフォルダへ入る。選ぶまでは今の場所に置いたままにする。
 */

function makeService(
  conflict: unknown,
  categories: { id: string; name: string }[] = [],
) {
  const updates: { id: string; categoryId: string }[] = [];
  let resolvedAt: Date | null = null;
  const created: string[] = [];
  const prisma = {
    classifyConflict: {
      findUnique: jest.fn(() => Promise.resolve(conflict)),
      update: jest.fn((args: { data: { resolvedAt: Date } }) => {
        resolvedAt = args.data.resolvedAt;
        return Promise.resolve({});
      }),
      count: jest.fn(() => Promise.resolve(2)),
    },
    manualCategory: {
      findFirst: jest.fn((args: { where: { name: string } }) =>
        Promise.resolve(
          categories.find((c) => c.name === args.where.name) ?? null,
        ),
      ),
      create: jest.fn((args: { data: { name: string } }) => {
        created.push(args.data.name);
        return Promise.resolve({ id: 'new-cat', name: args.data.name });
      }),
    },
    manual: {
      update: jest.fn(
        (args: { where: { id: string }; data: { categoryId: string } }) => {
          updates.push({ id: args.where.id, categoryId: args.data.categoryId });
          return Promise.resolve({});
        },
      ),
    },
  };
  const service = new ManualService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as RagService,
    // 裏処理の投げ先。ここで試すのは保留の解決だけで取り込みも再分類も通らない
    {} as JobDispatcher,
  );
  return { service, updates, created, resolved: () => resolvedAt };
}

const pending = {
  manualId: 'm1',
  candidates: ['共通アフター対応マニュアル', '建具・内装対応'],
  resolvedAt: null,
};

describe('resolveConflict', () => {
  it('選んだフォルダへ入れて、保留を解く', async () => {
    const { service, updates, resolved } = makeService(pending, [
      { id: 'cat-a', name: '共通アフター対応マニュアル' },
    ]);

    const result = await service.resolveConflict(
      'm1',
      '共通アフター対応マニュアル',
    );

    expect(updates).toEqual([{ id: 'm1', categoryId: 'cat-a' }]);
    expect(result.movedTo).toBe('共通アフター対応マニュアル');
    expect(resolved()).toBeInstanceOf(Date);
  });

  it('「今のまま」を選んだら動かさずに保留だけ解く', async () => {
    const { service, updates, resolved } = makeService(pending);

    const result = await service.resolveConflict('m1', null);

    expect(updates).toEqual([]);
    expect(result.movedTo).toBeNull();
    expect(resolved()).toBeInstanceOf(Date);
  });

  it('候補に無いフォルダは選べない(画面と食い違う指定を弾く)', async () => {
    const { service, updates } = makeService(pending);

    await expect(
      service.resolveConflict('m1', '関係ないフォルダ'),
    ).rejects.toThrow('候補にないフォルダは選べません');
    expect(updates).toEqual([]);
  });

  it('候補のフォルダがまだ無ければ作る', async () => {
    const { service, created } = makeService(pending, []);

    await service.resolveConflict('m1', '建具・内装対応');

    expect(created).toEqual(['建具・内装対応']);
  });

  it('すでに解決済みなら受け付けない(二重に処理しない)', async () => {
    const { service } = makeService({ ...pending, resolvedAt: new Date() });
    await expect(service.resolveConflict('m1', null)).rejects.toThrow(
      'この保留はもうありません',
    );
  });

  it('保留が無ければ受け付けない', async () => {
    const { service } = makeService(null);
    await expect(service.resolveConflict('m1', null)).rejects.toThrow(
      'この保留はもうありません',
    );
  });

  it('残りの件数を返す(次を促すため)', async () => {
    const { service } = makeService(pending);
    expect((await service.resolveConflict('m1', null)).remaining).toBe(2);
  });
});
