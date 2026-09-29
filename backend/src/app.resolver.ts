import { Query, Resolver } from '@nestjs/graphql';
import { Public } from './auth/public';
import { PrismaService } from './prisma/service';

@Resolver()
export class AppResolver {
  constructor(private readonly prisma: PrismaService) {}

  // ヘルスチェックだけはログイン無しで叩ける(死活監視用)
  @Public()
  @Query(() => String)
  health(): string {
    return 'ok';
  }

  @Query(() => String)
  async dbHealth(): Promise<string> {
    await this.prisma.$queryRaw`SELECT 1`;
    return 'db ok';
  }
}
