import { ManualService } from './service';
import { IngestStatus } from './model';
import type { PrismaService } from '../prisma/service';
import type { JobDispatcher } from '../job/dispatcher';
import type { RagService } from '../rag/service';
import type { StorageService } from '../storage/service';

/**
 * 鍵付き(管理者だけに表示)フォルダの取り決めを固定するテスト。
 *
 * 1. 見える範囲: MEMBERには一覧・キーワード検索・ダウンロードのどこにも出さない。
 *    ここが抜けると、隠したはずの資料の題名や本文抜粋が一般利用者に出る。
 * 2. AIの分類: 行き先としては使う(「あのフォルダに入れて」が通るように)。
 *    中身は動かさない(AIの判断で鍵の外へ出ると全員に見えてしまう)。
 * 3. 鍵付きへ入れた分・動かさなかった分は、必ず呼び出し側へ返す(黙って隠さない)。
 *
 * ここで使う偽Prismaのwhere解釈が本物とずれていないかは、2026-08-19に
 * ローカルのPostgres(docker compose の db)へ実際に問い合わせて確認済み:
 * - `AND: []`(管理者のとき visibleTo が返す空配列)は「条件なし」として扱われる。
 *   findFirst({ where: { id, AND: [] } }) は対象を1件返す
 * - 壊れていた形(除外条件とキーワード条件のORを同じ階層に並べる)では、
 *   実DBでも鍵付きの中身が返ってきた。この漏れは偽物の都合ではなく本物の挙動
 */

type Category = {
  id: string;
  name: string;
  adminOnly: boolean;
  deletedAt: Date | null;
  sortOrder: number;
  createdByAi: boolean;
};

type Manual = {
  id: string;
  title: string;
  fileName: string;
  fileKey: string;
  categoryId: string | null;
  categoryPinned: boolean;
  ingestStatus: IngestStatus;
  deletedAt: Date | null;
  body: string;
};

const LOCKED: Category = {
  id: 'cat-locked',
  name: '福祉住環境コーディネーター',
  adminOnly: true,
  deletedAt: null,
  sortOrder: 0,
  createdByAi: false,
};

const OPEN: Category = {
  id: 'cat-open',
  name: '施工',
  adminOnly: false,
  deletedAt: null,
  sortOrder: 1,
  createdByAi: false,
};

const TRASHED: Category = {
  id: 'cat-trashed',
  name: '旧フォルダ',
  adminOnly: false,
  deletedAt: new Date('2026-01-01'),
  sortOrder: 2,
  createdByAi: false,
};

function manual(over: Partial<Manual> & { id: string; title: string }): Manual {
  return {
    fileName: `${over.title ?? 'file'}.pdf`,
    fileKey: `manuals/${over.id}.pdf`,
    categoryId: null,
    categoryPinned: false,
    ingestStatus: IngestStatus.COMPLETED,
    deletedAt: null,
    body: `${over.title}の本文。手すりの設置手順について。`,
    ...over,
  };
}

/** 部分一致の条件({ contains, mode }) */
type Contains = { contains: string; mode?: string };

function containsMatch(value: string, cond: Contains) {
  return value.toLowerCase().includes(cond.contains.toLowerCase());
}

/**
 * Prismaのwhere句のうち、この機能が使う形だけを解釈する簡易版。
 *
 * AND/ORを実際に入れ子で評価する。ここを「使うキーだけを個別に見る」実装に
 * すると、AND句に入れ忘れた条件を見逃す(まさにそれで漏れた)ため、
 * 構造をそのまま辿る形にしてある
 */
function makeMatcher(categories: Category[]) {
  const categoryOf = (m: Manual) =>
    categories.find((c) => c.id === m.categoryId) ?? null;

  const matchCategory = (
    category: Category | null,
    cond: Record<string, unknown>,
  ) => {
    // { category: { ... } } は「フォルダに入っていて、その条件を満たす」。
    // 未分類(null)はマッチしない — Prismaのto-oneリレーション条件と同じ
    if (!category) return false;
    for (const [key, val] of Object.entries(cond)) {
      if (key === 'adminOnly' && category.adminOnly !== val) return false;
      if (key === 'deletedAt' && category.deletedAt !== null) return false;
      if (key === 'name' && category.name !== val) return false;
    }
    return true;
  };

  const match = (m: Manual, where: Record<string, unknown>): boolean => {
    for (const [key, val] of Object.entries(where)) {
      if (val === undefined) continue;
      switch (key) {
        case 'AND':
          if (!(val as Record<string, unknown>[]).every((w) => match(m, w)))
            return false;
          break;
        case 'OR':
          if (!(val as Record<string, unknown>[]).some((w) => match(m, w)))
            return false;
          break;
        case 'category':
          if (!matchCategory(categoryOf(m), val as Record<string, unknown>))
            return false;
          break;
        case 'deletedAt': {
          const cond = val as Date | null | { not: null };
          if (cond && typeof cond === 'object' && 'not' in cond) {
            if (m.deletedAt === null) return false;
          } else if (cond === null) {
            if (m.deletedAt !== null) return false;
          } else if (m.deletedAt?.getTime() !== cond.getTime()) {
            return false;
          }
          break;
        }
        case 'id': {
          const cond = val as string | { in?: string[] };
          if (typeof cond === 'string') {
            if (m.id !== cond) return false;
          } else if (cond.in && !cond.in.includes(m.id)) return false;
          break;
        }
        case 'title':
          if (!containsMatch(m.title, val as Contains)) return false;
          break;
        case 'fileName':
          if (!containsMatch(m.fileName, val as Contains)) return false;
          break;
        case 'chunks': {
          const some = (val as { some: { content: Contains } }).some;
          if (!containsMatch(m.body, some.content)) return false;
          break;
        }
        default:
          if ((m as unknown as Record<string, unknown>)[key] !== val)
            return false;
      }
    }
    return true;
  };

  return { match, categoryOf };
}

function fakePrisma(manuals: Manual[], categories: Category[]) {
  const { match, categoryOf } = makeMatcher(categories);
  const shape = (m: Manual) => ({
    ...m,
    // include: { category: true } / select の両方で使うので行そのものを返す
    category: categoryOf(m),
    chunks: [{ content: m.body, chunkIndex: 0 }],
  });
  const matchCategoryRow = (
    c: Category,
    where: Record<string, unknown> = {},
  ) => {
    if ('deletedAt' in where) {
      const cond = where.deletedAt as null | { not: null };
      if (cond && typeof cond === 'object' && 'not' in cond) {
        if (c.deletedAt === null) return false;
      } else if (c.deletedAt !== null) return false;
    }
    if ('adminOnly' in where && c.adminOnly !== where.adminOnly) return false;
    if ('name' in where && c.name !== where.name) return false;
    const id = where.id as { in?: string[] } | undefined;
    if (id?.in && !id.in.includes(c.id)) return false;
    return true;
  };

  return {
    manual: {
      findMany: jest.fn((args: { where: Record<string, unknown> }) =>
        Promise.resolve(manuals.filter((m) => match(m, args.where)).map(shape)),
      ),
      findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
        const found = manuals.find((m) => match(m, args.where));
        return Promise.resolve(found ? shape(found) : null);
      }),
      update: jest.fn(
        (args: {
          where: { id: string };
          data: {
            categoryId?: string | null;
            deletedAt?: Date | null;
            categoryPinned?: boolean;
          };
        }) => {
          const m = manuals.find((x) => x.id === args.where.id)!;
          if ('categoryId' in args.data)
            m.categoryId = args.data.categoryId ?? null;
          if ('deletedAt' in args.data) m.deletedAt = args.data.deletedAt!;
          return Promise.resolve(shape(m));
        },
      ),
      updateMany: jest.fn(
        (args: {
          where: Record<string, unknown>;
          data: { deletedAt?: Date | null; categoryId?: string | null };
        }) => {
          const hit = manuals.filter((m) => {
            const w = args.where;
            if (w.categoryId !== undefined && m.categoryId !== w.categoryId)
              return false;
            if (w.deletedAt !== undefined) {
              const want = w.deletedAt as Date | null;
              const got = m.deletedAt;
              if (
                want === null ? got !== null : got?.getTime() !== want.getTime()
              )
                return false;
            }
            return true;
          });
          for (const m of hit) {
            if ('deletedAt' in args.data) m.deletedAt = args.data.deletedAt!;
            if ('categoryId' in args.data)
              m.categoryId = args.data.categoryId ?? null;
          }
          return Promise.resolve({ count: hit.length });
        },
      ),
      count: jest.fn((args: { where: Record<string, unknown> }) =>
        Promise.resolve(manuals.filter((m) => match(m, args.where)).length),
      ),
      groupBy: jest.fn(() =>
        Promise.resolve(
          categories.map((c) => ({
            categoryId: c.id,
            _count: {
              _all: manuals.filter(
                (m) => m.categoryId === c.id && m.deletedAt === null,
              ).length,
            },
          })),
        ),
      ),
    },
    manualCategory: {
      findMany: jest.fn((args?: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          categories.filter((c) => matchCategoryRow(c, args?.where)),
        ),
      ),
      update: jest.fn(
        (args: {
          where: { id: string };
          data: { deletedAt?: Date | null; name?: string };
        }) => {
          const c = categories.find((x) => x.id === args.where.id)!;
          if ('deletedAt' in args.data) c.deletedAt = args.data.deletedAt!;
          if (args.data.name) c.name = args.data.name;
          return Promise.resolve(c);
        },
      ),
      findFirst: jest.fn((args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          categories.find((c) => matchCategoryRow(c, args.where)) ?? null,
        ),
      ),
      delete: jest.fn((args: { where: { id: string } }) => {
        const i = categories.findIndex((c) => c.id === args.where.id);
        const [removed] = categories.splice(i, 1);
        return Promise.resolve(removed);
      }),
      create: jest.fn((args: { data: { name: string } }) => {
        const created: Category = {
          id: `cat-new-${categories.length}`,
          name: args.data.name,
          adminOnly: false,
          deletedAt: null,
          sortOrder: 99,
          createdByAi: true,
        };
        categories.push(created);
        return Promise.resolve(created);
      }),
    },
    classificationRule: { findMany: jest.fn(() => Promise.resolve([])) },
    // 再分類の控え(元に戻す用)。ここでは保存されることだけ確認できればよい
    reclassifySnapshot: {
      create: jest.fn((args: unknown) => Promise.resolve(args)),
      findFirst: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

function makeService(manuals: Manual[], categories: Category[]) {
  const prisma = fakePrisma(manuals, categories);
  const rag = {
    organize: jest.fn(() =>
      Promise.resolve([] as { manualId: string; category: string }[]),
    ),
  };
  const storage = {
    createDownloadUrl: jest.fn(() => Promise.resolve('https://example/signed')),
  };
  const service = new ManualService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    rag as unknown as RagService,
    // 裏処理の投げ先。ここでは分類の中身だけを見るので使われない
    {} as JobDispatcher,
  );
  return { service, prisma, rag, storage };
}

/** rag.organizeが最初に呼ばれたときの引数(分類対象と候補フォルダ) */
function firstOrganizeCall(rag: { organize: jest.Mock }) {
  const [manuals, categories] = rag.organize.mock.calls[0] as [
    { title: string }[],
    string[],
  ];
  return { titles: manuals.map((m) => m.title), candidates: categories };
}

// --- 1. 見える範囲 ---

describe('鍵付きフォルダの中身は一般利用者に見せない', () => {
  const locked = manual({
    id: 'm-locked',
    title: '福祉住環境コーディネーター試験対策',
    categoryId: LOCKED.id,
  });
  const open = manual({
    id: 'm-open',
    title: '手すり設置手順書',
    categoryId: OPEN.id,
  });
  const uncategorized = manual({ id: 'm-none', title: '未分類の手すりメモ' });

  const setup = () =>
    makeService(
      [{ ...locked }, { ...open }, { ...uncategorized }],
      [LOCKED, OPEN],
    );

  it('一覧に出ない', async () => {
    const { service } = setup();
    const titles = (await service.findAll()).map((m) => m.title);
    expect(titles).not.toContain(locked.title);
    expect(titles).toContain(open.title);
    expect(titles).toContain(uncategorized.title);
  });

  it('キーワード検索に出ない(題名も本文抜粋も)', async () => {
    const { service } = setup();

    // 題名での検索
    const byTitle = await service.search('福祉住環境');
    expect(byTitle).toEqual([]);

    // 本文での検索。ここが漏れていた。除外条件とキーワード条件が
    // どちらもORを使うため、同じ階層に並べると片方が上書きで消える
    const byBody = await service.search('手すり');
    expect(byBody.map((r) => r.manual.title).sort()).toEqual(
      [open.title, uncategorized.title].sort(),
    );
  });

  it('IDを知っていてもダウンロードできない', async () => {
    const { service } = setup();
    await expect(service.getDownloadUrl(locked.id)).rejects.toThrow();
    await expect(service.getDownloadUrl(open.id)).resolves.toBeTruthy();
  });

  it('一括ダウンロードの対象にもならない', async () => {
    const { service } = setup();
    const targets = await service.getDownloadTargets([locked.id, open.id]);
    expect(targets.map((t) => t.title)).toEqual([open.title]);
  });

  it('管理者にはすべて見える', async () => {
    const { service } = setup();
    const titles = (await service.findAll(undefined, undefined, true)).map(
      (m) => m.title,
    );
    expect(titles).toContain(locked.title);
    const hits = await service.search('福祉住環境', true);
    expect(hits.map((r) => r.manual.title)).toContain(locked.title);
    await expect(service.getDownloadUrl(locked.id, true)).resolves.toBeTruthy();
  });
});

// --- 2. AIの分類での扱い ---

describe('全件再分類での鍵付きフォルダの扱い', () => {
  it('鍵付きフォルダも行き先の候補としてAIに渡す', async () => {
    const { service, rag } = makeService(
      [manual({ id: 'm1', title: '顛末書見本', categoryId: OPEN.id })],
      [LOCKED, OPEN],
    );

    await service.reclassifyAll();

    expect(firstOrganizeCall(rag).candidates).toContain(LOCKED.name);
  });

  it('ゴミ箱の中のフォルダは候補にしない', async () => {
    const { service, rag } = makeService(
      [manual({ id: 'm1', title: '顛末書見本', categoryId: OPEN.id })],
      [LOCKED, OPEN, TRASHED],
    );

    await service.reclassifyAll();

    expect(firstOrganizeCall(rag).candidates).not.toContain(TRASHED.name);
  });

  it('鍵付きフォルダの中身は動かさない(隠していた資料が表に出るのを防ぐ)', async () => {
    const { service, rag } = makeService(
      [
        manual({ id: 'm1', title: '顛末書見本', categoryId: OPEN.id }),
        manual({ id: 'm2', title: '試験対策メモ', categoryId: LOCKED.id }),
      ],
      [LOCKED, OPEN],
    );

    await service.reclassifyAll();

    expect(firstOrganizeCall(rag).titles).toEqual(['顛末書見本']);
  });

  it('AIが鍵付きフォルダを選んだら移動し、そのことを呼び出し側へ返す', async () => {
    const manuals = [manual({ id: 'm1', title: '試験対策メモ' })];
    const { service, rag } = makeService(manuals, [LOCKED, OPEN]);
    rag.organize.mockResolvedValue([{ manualId: 'm1', category: LOCKED.name }]);

    const result = await service.reclassifyAll();

    expect(result.movedCount).toBe(1);
    expect(manuals[0].categoryId).toBe(LOCKED.id);
    // 黙って隠さない。画面がこれを見て🔒付きで伝える
    expect(result.movedToLocked).toEqual(['試験対策メモ']);
    expect(result.moved[0]).toMatchObject({
      title: '試験対策メモ',
      categoryName: LOCKED.name,
      adminOnly: true,
    });
  });

  it('鍵なしフォルダへ入れた分は鍵付きの報告に混ぜない', async () => {
    const manuals = [manual({ id: 'm1', title: '顛末書見本' })];
    const { service, rag } = makeService(manuals, [LOCKED, OPEN]);
    rag.organize.mockResolvedValue([{ manualId: 'm1', category: OPEN.name }]);

    const result = await service.reclassifyAll();

    expect(result.movedToLocked).toEqual([]);
    expect(result.moved[0].adminOnly).toBe(false);
  });

  it('ゴミ箱の中のフォルダ名をAIが返しても、そこへは入れない', async () => {
    const manuals = [manual({ id: 'm1', title: '試験対策メモ' })];
    const { service, rag } = makeService(manuals, [OPEN, TRASHED]);
    rag.organize.mockResolvedValue([
      { manualId: 'm1', category: TRASHED.name },
    ]);

    await service.reclassifyAll();

    // 同名の新しいフォルダが作られ、ゴミ箱の中には入らない
    expect(manuals[0].categoryId).not.toBe(TRASHED.id);
  });
});

describe('選んだファイルだけの分類', () => {
  it('鍵付きフォルダの中身は選んでも動かさず、理由を返す', async () => {
    const manuals = [
      manual({ id: 'm2', title: '試験対策メモ', categoryId: LOCKED.id }),
    ];
    const { service, rag } = makeService(manuals, [LOCKED, OPEN]);

    const result = await service.reclassifySelected(['m2']);

    expect(rag.organize).not.toHaveBeenCalled();
    expect(manuals[0].categoryId).toBe(LOCKED.id);
    // 黙って何もしないと「効かなかった」ようにしか見えないので、名前で返す
    expect(result.skippedLocked).toEqual(['試験対策メモ']);
  });

  it('鍵なしのファイルは選べば動く', async () => {
    const manuals = [
      manual({ id: 'm1', title: '顛末書見本', categoryId: OPEN.id }),
    ];
    const { service, rag } = makeService(manuals, [LOCKED, OPEN]);
    rag.organize.mockResolvedValue([{ manualId: 'm1', category: LOCKED.name }]);

    const result = await service.reclassifySelected(['m1']);

    expect(result.movedCount).toBe(1);
    expect(result.skippedLocked).toEqual([]);
    expect(result.moved[0]).toMatchObject({
      title: '顛末書見本',
      categoryName: LOCKED.name,
      adminOnly: true,
    });
  });

  it('ピン留めされたファイルは選ばれても動かさない', async () => {
    const { service, rag } = makeService(
      [
        manual({
          id: 'm2',
          title: '試験対策メモ',
          categoryId: OPEN.id,
          categoryPinned: true,
        }),
      ],
      [LOCKED, OPEN],
    );

    const result = await service.reclassifySelected(['m2']);

    expect(result.skippedPinned).toEqual(['試験対策メモ']);
    expect(rag.organize).not.toHaveBeenCalled();
  });
});

// --- 3. 再分類の件数 ---

describe('再分類の対象件数', () => {
  it('鍵付きフォルダの中身を対象に数えない(確認画面の件数が実際と合うように)', async () => {
    const { service } = makeService(
      [
        manual({ id: 'm1', title: '顛末書見本', categoryId: OPEN.id }),
        manual({ id: 'm2', title: '試験対策メモ', categoryId: LOCKED.id }),
        manual({ id: 'm3', title: '未分類メモ' }),
        manual({
          id: 'm4',
          title: 'ピン留め済み',
          categoryId: OPEN.id,
          categoryPinned: true,
        }),
      ],
      [LOCKED, OPEN],
    );

    const counts = await service.reclassifyCounts();

    // 実際にorganizeManualsが拾うのは m1 と m3 の2件
    expect(counts.target).toBe(2);
    expect(counts.pinned).toBe(1);
    expect(counts.locked).toBe(1);
  });
});

// --- 4. ゴミ箱からの復元 ---

describe('ゴミ箱から戻すときに鍵が外れない', () => {
  it('同名でも鍵の有無が違うフォルダにはまとめない(別の名前で戻す)', async () => {
    const trashedLocked: Category = {
      id: 'cat-trashed-locked',
      name: '人事',
      adminOnly: true,
      deletedAt: new Date('2026-08-01'),
      sortOrder: 5,
      createdByAi: false,
    };
    const liveOpen: Category = {
      id: 'cat-live-open',
      name: '人事',
      adminOnly: false,
      deletedAt: null,
      sortOrder: 6,
      createdByAi: true,
    };
    const manuals = [
      manual({
        id: 'm-pay',
        title: '給与テーブル',
        categoryId: trashedLocked.id,
        deletedAt: new Date('2026-08-01'),
      }),
    ];
    const { service } = makeService(manuals, [trashedLocked, liveOpen]);

    const result = await service.restoreCategories([trashedLocked.id]);

    // 鍵なしの「人事」へは入れない
    expect(manuals[0].categoryId).toBe(trashedLocked.id);
    expect(manuals[0].deletedAt).toBeNull();
    expect(trashedLocked.adminOnly).toBe(true);
    expect(trashedLocked.deletedAt).toBeNull();
    expect(result.restoredSeparately).toEqual(['人事 (復元)']);
    expect(result.mergedInto).toEqual([]);
  });

  it('鍵の有無が同じなら今まで通りまとめる', async () => {
    const trashedOpen: Category = {
      id: 'cat-trashed-open',
      name: '施工',
      adminOnly: false,
      deletedAt: new Date('2026-08-01'),
      sortOrder: 5,
      createdByAi: false,
    };
    const manuals = [
      manual({
        id: 'm1',
        title: '顛末書見本',
        categoryId: trashedOpen.id,
        deletedAt: new Date('2026-08-01'),
      }),
    ];
    const { service } = makeService(manuals, [trashedOpen, OPEN]);

    const result = await service.restoreCategories([trashedOpen.id]);

    expect(manuals[0].categoryId).toBe(OPEN.id);
    expect(result.mergedInto).toEqual(['施工']);
    expect(result.restoredSeparately).toEqual([]);
  });

  it('鍵付きフォルダの中の1件だけを戻すとき、未分類へ出さない', async () => {
    const trashedLocked: Category = {
      id: 'cat-trashed-locked',
      name: '人事',
      adminOnly: true,
      deletedAt: new Date('2026-08-02'),
      sortOrder: 5,
      createdByAi: false,
    };
    // フォルダより先に個別に捨てられたので、日時がずれている
    const manuals = [
      manual({
        id: 'm-pay',
        title: '給与テーブル',
        categoryId: trashedLocked.id,
        deletedAt: new Date('2026-08-01'),
      }),
    ];
    const { service } = makeService(manuals, [trashedLocked]);

    await service.restoreMany(['m-pay']);

    // 未分類(誰でも見える)ではなく、元の鍵付きフォルダへ戻る
    expect(manuals[0].categoryId).toBe(trashedLocked.id);
    expect(manuals[0].deletedAt).toBeNull();
    expect(trashedLocked.deletedAt).toBeNull();
  });

  it('鍵なしフォルダの中の1件は、これまで通り未分類へ戻す', async () => {
    const trashedOpen: Category = {
      id: 'cat-trashed-open',
      name: '施工',
      adminOnly: false,
      deletedAt: new Date('2026-08-02'),
      sortOrder: 5,
      createdByAi: false,
    };
    const manuals = [
      manual({
        id: 'm1',
        title: '顛末書見本',
        categoryId: trashedOpen.id,
        deletedAt: new Date('2026-08-01'),
      }),
    ];
    const { service } = makeService(manuals, [trashedOpen]);

    await service.restoreMany(['m1']);

    expect(manuals[0].categoryId).toBeNull();
    expect(trashedOpen.deletedAt).not.toBeNull();
  });
});
