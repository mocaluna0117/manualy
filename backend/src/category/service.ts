import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/service';

@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * フォルダ一覧。
   *
   * @param includeAdminOnly 管理者だけに見せるフォルダも含めるか。
   *   既定はfalse(呼び出し側が権限を渡し忘れても漏れない側に倒す)
   */
  async findAll(includeAdminOnly = false) {
    // 管理者が決めた並び順が優先。同値(未設定)なら名前順で安定させる
    const categories = await this.prisma.manualCategory.findMany({
      where: {
        deletedAt: null,
        ...(includeAdminOnly ? {} : { adminOnly: false }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    // 一覧の「サイズ」列に出す、フォルダ内のファイル合計。
    // カテゴリごとに数えると件数分のクエリになるので1回にまとめる
    const totals = await this.prisma.manual.groupBy({
      by: ['categoryId'],
      where: { deletedAt: null }, // ゴミ箱の中は数えない
      _sum: { size: true },
      _count: { _all: true },
    });
    const byCategory = new Map(
      totals.map((t) => [
        t.categoryId,
        { size: t._sum.size ?? 0, count: t._count._all },
      ]),
    );
    return categories.map((category) => ({
      ...category,
      totalSize: byCategory.get(category.id)?.size ?? 0,
      manualCount: byCategory.get(category.id)?.count ?? 0,
    }));
  }

  /** 名前で1件探す(生きているフォルダのみ)。チャットの重複判定に使う */
  findByName(name: string) {
    return this.prisma.manualCategory.findFirst({
      where: { name: name.trim().normalize('NFC'), deletedAt: null },
    });
  }

  /**
   * 名前の一部からフォルダを探す(チャットの「〇〇フォルダの名前を変えて」用)。
   * まず完全一致で決め、無ければ部分一致の候補を返す
   */
  async findByPartialName(needle: string) {
    const text = needle.trim().normalize('NFC');
    if (!text) return { status: 'invalid' as const };
    const exact = await this.findByName(text);
    if (exact) return { status: 'found' as const, category: exact };

    const candidates = await this.prisma.manualCategory.findMany({
      where: { name: { contains: text, mode: 'insensitive' }, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    if (candidates.length === 1) {
      return { status: 'found' as const, category: candidates[0] };
    }
    // 見つからない/複数あるときは、選び直せるよう今あるフォルダを添えて返す
    const all = await this.prisma.manualCategory.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return candidates.length === 0
      ? { status: 'not_found' as const, folders: all }
      : { status: 'ambiguous' as const, folders: candidates };
  }

  async create(name: string, adminOnly = false) {
    const trimmed = await this.validateName(name);
    // 新しいフォルダは一番下に置く
    const last = await this.prisma.manualCategory.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return this.prisma.manualCategory.create({
      // 画面の「+」からでも、チャットで頼まれて作る場合でも、
      // 「利用者が作ると決めた箱」なのでAI作成にはしない。
      // 再分類で空になっても、勝手に消す候補として扱わないため
      data: {
        name: trimmed,
        sortOrder: (last?.sortOrder ?? 0) + 1,
        createdByAi: false,
        adminOnly,
      },
    });
  }

  /**
   * フォルダの並び順を保存する(ドラッグでの入れ替え)。
   * 渡されたidの順に1,2,3…を振る。一覧に無いidは無視し、
   * 渡されなかったフォルダ(同時に別の人が作った等)は末尾に回す
   */
  async reorder(ids: string[]) {
    const categories = await this.prisma.manualCategory.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true },
    });
    const known = new Set(categories.map((c) => c.id));
    const ordered = ids.filter((id) => known.has(id));
    const rest = categories
      .map((c) => c.id)
      .filter((id) => !ordered.includes(id));
    const finalOrder = [...ordered, ...rest];

    // 全件をまとめて更新する(順序の整合が崩れた中間状態を残さない)
    await this.prisma.$transaction(
      finalOrder.map((id, index) =>
        this.prisma.manualCategory.update({
          where: { id },
          data: { sortOrder: index + 1 },
        }),
      ),
    );
    return finalOrder.length;
  }

  /**
   * フォルダの名前と見せる範囲を変える。
   * adminOnlyを省いたときは今のままにする(名前の変更だけで公開範囲が動かないように)
   */
  async rename(id: string, name: string, adminOnly?: boolean) {
    const trimmed = await this.validateName(name, id);
    const category = await this.prisma.manualCategory.findUnique({
      where: { id },
    });
    if (!category) {
      throw new BadRequestException('カテゴリが見つかりません');
    }
    return this.prisma.manualCategory.update({
      where: { id },
      data: {
        name: trimmed,
        ...(adminOnly === undefined ? {} : { adminOnly }),
      },
    });
  }

  /** 空文字と重複名をチェックする(excludeId=リネーム時の自分自身は除外) */
  private async validateName(name: string, excludeId?: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException('カテゴリ名を入力してください');
    }
    // 名前の一意性は「生きているフォルダ」の中だけ(部分インデックス)。
    // ゴミ箱の中に同名があっても新しく作れる
    const duplicate = await this.prisma.manualCategory.findFirst({
      where: {
        name: trimmed,
        deletedAt: null,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
    });
    if (duplicate) {
      throw new BadRequestException(`フォルダ「${trimmed}」は既に存在します`);
    }
    return trimmed;
  }

  /**
   * フォルダをゴミ箱へ入れる。中のマニュアルも一緒に入る。
   *
   * フォルダと中身に「同じ日時」を入れるのが要点で、復元のときに
   * 「このフォルダと一緒に捨てられたもの」だけを戻せるようにしている
   * (フォルダを捨てる前から個別にゴミ箱にあったものは、そのまま残す)
   */
  async delete(id: string) {
    const category = await this.prisma.manualCategory.findFirst({
      where: { id, deletedAt: null },
    });
    if (!category) {
      throw new BadRequestException('フォルダが見つかりません');
    }
    const deletedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.manual.updateMany({
        where: { categoryId: id, deletedAt: null },
        data: { deletedAt },
      }),
      this.prisma.manualCategory.update({
        where: { id },
        data: { deletedAt },
      }),
    ]);
    return { ...category, deletedAt };
  }
}
