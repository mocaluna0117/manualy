/**
 * S3にアップロード済みのPDFをマニュアルとして登録し、取り込み完了まで待つ。
 * 使い方ガイドのような「運用側で用意するPDF」を画面を経由せずに登録するための
 * 運用スクリプト。同名ファイルが既にあれば差し替える(ガイドの更新に使える)。
 *
 * 必要な環境変数:
 *   MANUAL_TITLE     … 一覧に出すタイトル
 *   MANUAL_FILE_KEY  … S3上のキー(アップロード済みであること)
 *   MANUAL_FILE_NAME … ファイル名(同名判定に使う)
 *   MANUAL_SIZE      … ファイルサイズ(バイト)
 *
 * 実行(本番はECSの一発タスクで。RAG_SERVICE_URLの上書きが必要な点はreingest-allと同じ):
 *   node dist/src/scripts/register-manual-file.js
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IngestStatus } from '../manual/model';
import { ManualService } from '../manual/service';
import { PrismaService } from '../prisma/service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const title = process.env.MANUAL_TITLE;
  const fileKey = process.env.MANUAL_FILE_KEY;
  const fileName = process.env.MANUAL_FILE_NAME;
  const size = Number(process.env.MANUAL_SIZE);
  if (!title || !fileKey || !fileName || !Number.isFinite(size)) {
    throw new Error(
      'MANUAL_TITLE / MANUAL_FILE_KEY / MANUAL_FILE_NAME / MANUAL_SIZE を指定してください',
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  const manualService = app.get(ManualService);
  const prisma = app.get(PrismaService);

  const { manual, outcome } = await manualService.register({
    title,
    fileKey,
    fileName,
    size,
    autoCategorize: false,
    forceReplace: true, // 再実行=ガイドの更新なので常に差し替える
  });
  console.log(`登録: ${outcome} id=${manual.id} 「${manual.title}」`);

  // 取り込みは裏で走るので、終わるまで待って結果を報告する
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    const current = await prisma.manual.findUniqueOrThrow({
      where: { id: manual.id },
    });
    if (current.ingestStatus === IngestStatus.COMPLETED) {
      console.log(`取り込み完了: ${current.chunkCount}チャンク`);
      await app.close();
      return;
    }
    if (current.ingestStatus === IngestStatus.FAILED) {
      throw new Error(`取り込み失敗: ${current.ingestError}`);
    }
  }
  throw new Error('取り込みが5分以内に終わりませんでした');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
