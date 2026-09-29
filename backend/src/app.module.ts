import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import { AppResolver } from './app.resolver';
import { AnalyticsModule } from './analytics/module';
import { AuthModule } from './auth/module';
import { CategoryModule } from './category/module';
import { ChatModule } from './chat/module';
import { HealthController } from './health/controller';
import { InquiryModule } from './inquiry/module';
import { ManualModule } from './manual/module';
import { PrismaModule } from './prisma/module';
import { RagModule } from './rag/module';
import { RuleModule } from './rule/module';
import { TemplateModule } from './template/module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      playground: true,
      plugins: [],
      // 認証ガードがHTTPリクエスト(のAuthorizationヘッダ)を読めるようにcontextへ渡す。
      // resはクライアント切断の検知(チャットの停止ボタン)に使う
      context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
    }),
    AnalyticsModule,
    AuthModule,
    PrismaModule,
    CategoryModule,
    ChatModule,
    // 移行が終わったら消す(無料クレジットの残りを管理者に見せるだけ)
    ManualModule,
    InquiryModule,
    RagModule,
    RuleModule,
    TemplateModule,
  ],
  controllers: [HealthController],
  providers: [AppResolver],
})
export class AppModule {}
