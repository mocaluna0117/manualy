import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/module';
import { InquiryResolver } from './resolver';
import { InquiryService } from './service';

@Module({
  // 添付画像をS3へ置き、一覧では期限付きURLにして返す
  imports: [StorageModule],
  providers: [InquiryService, InquiryResolver],
})
export class InquiryModule {}
