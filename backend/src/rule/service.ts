import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/service';

const MAX_LENGTH = 200;
const MAX_RULES = 50;

/**
 * 分類ルールの唯一の入口。
 * チャット経由(AIのツール/確定コマンド)も管理画面も、必ずここを通す。
 * 検証や重複チェックが片方だけ抜ける事故を防ぐため
 */
@Injectable()
export class RuleService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    // 同時刻に作られても順序がぶれないよう第2キーを持たせる
    return this.prisma.classificationRule.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async create(text: string) {
    const trimmed = this.validate(text);
    // 同じ内容を何度も登録すると分類プロンプトが無駄に膨らむ
    const duplicate = await this.prisma.classificationRule.findFirst({
      where: { text: trimmed },
    });
    if (duplicate) {
      throw new BadRequestException(
        `同じ分類ルールが既に登録されています: 「${trimmed}」`,
      );
    }
    const count = await this.prisma.classificationRule.count();
    if (count >= MAX_RULES) {
      throw new BadRequestException(
        `分類ルールは${MAX_RULES}件までです。不要なものを削除してください`,
      );
    }
    return this.prisma.classificationRule.create({ data: { text: trimmed } });
  }

  async update(id: string, text: string) {
    const trimmed = this.validate(text);
    await this.byId(id);
    return this.prisma.classificationRule.update({
      where: { id },
      data: { text: trimmed },
    });
  }

  async delete(id: string) {
    await this.byId(id);
    return this.prisma.classificationRule.delete({ where: { id } });
  }

  /**
   * チャットからの削除用。番号は会話の途中でずれるため、
   * 文言での指定を優先し、番号は補助として扱う
   */
  async deleteByTextOrNumber(text?: string, number?: number) {
    const rules = await this.findAll();
    const needle = text?.normalize('NFC').trim();
    if (needle) {
      const matches = rules.filter(
        (r) =>
          r.text.normalize('NFC').includes(needle) ||
          needle.includes(r.text.normalize('NFC')),
      );
      if (matches.length === 1) {
        await this.prisma.classificationRule.delete({
          where: { id: matches[0].id },
        });
        return { deleted: matches[0], candidates: [] };
      }
      // 0件/複数件は消さずに候補を返す(取り違えて消さない)
      if (matches.length > 1) return { deleted: null, candidates: matches };
    }
    if (Number.isInteger(number) && number! >= 1 && rules[number! - 1]) {
      const target = rules[number! - 1];
      await this.prisma.classificationRule.delete({ where: { id: target.id } });
      return { deleted: target, candidates: [] };
    }
    return { deleted: null, candidates: [] };
  }

  private validate(text: string) {
    const trimmed = text.normalize('NFC').trim();
    if (!trimmed) {
      throw new BadRequestException('分類ルールの内容を入力してください');
    }
    if (trimmed.length > MAX_LENGTH) {
      throw new BadRequestException(
        `分類ルールは${MAX_LENGTH}文字までにしてください`,
      );
    }
    return trimmed;
  }

  private async byId(id: string) {
    const found = await this.prisma.classificationRule.findUnique({
      where: { id },
    });
    if (!found) {
      throw new BadRequestException('分類ルールが見つかりません');
    }
    return found;
  }
}
