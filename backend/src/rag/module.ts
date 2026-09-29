import { Module } from '@nestjs/common';
import { RagResolver } from './resolver';
import { RagService } from './service';

@Module({
  providers: [RagService, RagResolver],
  exports: [RagService],
})
export class RagModule {}
