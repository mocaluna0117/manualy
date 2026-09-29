import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/service';

@Injectable()
export class TemplateService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    // 管理者が決めた並び順が優先。同値なら作成順で安定させる
    return this.prisma.promptTemplate.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(title: string, body: string) {
    const data = this.validate(title, body);
    // 新しいテンプレートは一番下に置く
    const last = await this.prisma.promptTemplate.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return this.prisma.promptTemplate.create({
      data: { ...data, sortOrder: (last?.sortOrder ?? 0) + 1 },
    });
  }

  async update(id: string, title: string, body: string) {
    const data = this.validate(title, body);
    await this.ensureExists(id);
    return this.prisma.promptTemplate.update({ where: { id }, data });
  }

  async delete(id: string) {
    await this.ensureExists(id);
    return this.prisma.promptTemplate.delete({ where: { id } });
  }

  /** 渡されたidの順に並び順を振り直す。一覧に無いidは無視し、渡されなかった分は末尾へ */
  async reorder(ids: string[]) {
    const templates = await this.prisma.promptTemplate.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    const known = new Set(templates.map((t) => t.id));
    const ordered = ids.filter((id) => known.has(id));
    const rest = templates
      .map((t) => t.id)
      .filter((id) => !ordered.includes(id));
    const finalOrder = [...ordered, ...rest];
    await this.prisma.$transaction(
      finalOrder.map((id, index) =>
        this.prisma.promptTemplate.update({
          where: { id },
          data: { sortOrder: index + 1 },
        }),
      ),
    );
    return finalOrder.length;
  }

  private validate(title: string, body: string) {
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle) {
      throw new BadRequestException('テンプレート名を入力してください');
    }
    if (!trimmedBody) {
      throw new BadRequestException('本文を入力してください');
    }
    return { title: trimmedTitle, body: trimmedBody };
  }

  private async ensureExists(id: string) {
    const found = await this.prisma.promptTemplate.findUnique({
      where: { id },
    });
    if (!found) {
      throw new BadRequestException('テンプレートが見つかりません');
    }
  }
}
