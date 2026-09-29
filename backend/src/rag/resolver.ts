import { Args, Query, Resolver } from '@nestjs/graphql';
import { RagAnswer } from './model';
import { RagService } from './service';

@Resolver()
export class RagResolver {
  constructor(private readonly ragService: RagService) {}

  // フロント→NestJS→Python の経路確認用
  @Query(() => String)
  ragHealth() {
    return this.ragService.health();
  }

  // AI検索。質問文を渡すと回答と根拠マニュアルが返る
  @Query(() => RagAnswer)
  ragSearch(@Args('question') question: string) {
    return this.ragService.search(question);
  }
}
