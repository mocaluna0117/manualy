import { Module } from '@nestjs/common';
import { JobModule } from '../job/module';
import { RagModule } from '../rag/module';
import { UserModule } from '../user/module';
import { StorageModule } from '../storage/module';
import { ManualResolver } from './resolver';
import { ManualService } from './service';

@Module({
  // 読み取りのたびに「今の人が管理者か」を見るため(隠しフォルダの絞り込み)。
  // JobModuleは、応答を返したあとに走らせたい処理(取り込み・再分類)の投げ先
  imports: [StorageModule, RagModule, UserModule, JobModule],
  providers: [ManualResolver, ManualService],
  exports: [ManualService], // チャットの管理操作(再分類)から使う
})
export class ManualModule {}
