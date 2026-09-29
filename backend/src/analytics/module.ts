import { Module } from '@nestjs/common';
import { RagModule } from '../rag/module';
import { AnalyticsResolver } from './resolver';
import { AnalyticsService } from './service';

@Module({
  // 質問のテーマ分けにAI(RAGサービス)を使う
  imports: [RagModule],
  providers: [AnalyticsService, AnalyticsResolver],
})
export class AnalyticsModule {}
