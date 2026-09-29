import { Module } from '@nestjs/common';
import { JobDispatcher } from './dispatcher';

/**
 * 応答を返したあとに走らせたい処理の投げ先(JobDispatcher)を配るだけのモジュール。
 *
 * 内部エンドポイントのコントローラ(controller.ts)はここに登録しない。
 * ManualService と ChatService の両方を使うので、既に両方へ手が届く
 * ChatModule の controllers に置いている(理由は controller.ts に書いた)
 */
@Module({
  providers: [JobDispatcher],
  exports: [JobDispatcher],
})
export class JobModule {}
