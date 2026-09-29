/**
 * 既存マニュアルのタイトル・ファイル名をNFCに正規化する一回きりの移行スクリプト。
 *
 * macOSのファイル名はNFD(濁点・半濁点が結合文字)でアップロードされるため、
 * 正規化前に登録されたマニュアルは、NFCで入力される検索キーワードの
 * 部分一致(ILIKE)に当たらない。register()側の入口正規化とセットで使う。
 * 何度実行しても安全(対象が無ければ0件更新)。
 *
 * 実行: cd backend && npm run build && node dist/src/scripts/normalize-titles.js
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  const prisma = app.get(PrismaService);

  // PostgreSQL側のnormalize()で一括修正する。全行舐める必要はなく、
  // 正規化で変わる行だけをUPDATEする
  const titles = await prisma.$executeRaw`
    UPDATE "Manual" SET title = normalize(title, NFC)
    WHERE title <> normalize(title, NFC)`;
  const fileNames = await prisma.$executeRaw`
    UPDATE "Manual" SET file_name = normalize(file_name, NFC)
    WHERE file_name <> normalize(file_name, NFC)`;

  console.log(`NFCに正規化: タイトル ${titles}件 / ファイル名 ${fileNames}件`);
  await app.close();
}

void main();
