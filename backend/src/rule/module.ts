import { Module } from '@nestjs/common';
import { RuleResolver } from './resolver';
import { RuleService } from './service';

@Module({
  providers: [RuleService, RuleResolver],
  exports: [RuleService], // チャット経由のルール操作でも使う
})
export class RuleModule {}
