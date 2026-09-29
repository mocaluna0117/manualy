import { Module } from '@nestjs/common';
import { UserModule } from '../user/module';
import { CategoryResolver } from './resolver';
import { CategoryService } from './service';

@Module({
  // 一覧を出す前に「今の人が管理者か」を見るため
  imports: [UserModule],
  providers: [CategoryService, CategoryResolver],
  exports: [CategoryService], // チャットの管理操作(フォルダ作成)から使う
})
export class CategoryModule {}
