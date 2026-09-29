import { Module } from '@nestjs/common';
import { CategoryModule } from '../category/module';
import { InternalJobController } from '../job/controller';
import { ManualModule } from '../manual/module';
import { RagModule } from '../rag/module';
import { RuleModule } from '../rule/module';
import { StorageModule } from '../storage/module';
import { UserModule } from '../user/module';
import { ChatResolver } from './resolver';
import { ChatStreamController } from './stream-controller';
import { ChatService } from './service';

@Module({
  // Category/Manualはチャット経由の管理操作(フォルダ作成・再分類)で使う
  imports: [
    RagModule,
    UserModule,
    CategoryModule,
    ManualModule,
    RuleModule,
    // 質問に添えられた画像をS3へ置く(会話を開き直しても見返せるように)
    StorageModule,
  ],
  // 内部エンドポイント(Cloud Tasks/自分自身から叩く裏処理)はここに登録する。
  // ManualServiceとChatServiceの両方が要るが、ChatModuleは既にManualModuleを
  // importしているので、ここに置けば循環もapp.module.tsの編集も避けられる
  controllers: [ChatStreamController, InternalJobController],
  providers: [ChatService, ChatResolver],
})
export class ChatModule {}
