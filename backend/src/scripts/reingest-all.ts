/**
 * 全マニュアルを再インジェストする運用スクリプト。
 *
 * 埋め込みの作り方を変えたとき(例: タイトル前置き)に、既存マニュアルへ
 * 新方式を反映するために使う。GraphQL(要Cognito認証)を経由せず、
 * NestJSのアプリケーションコンテキストから ManualService を直接呼ぶので、
 * .env が向いている環境(ローカル/本番)に対してそのまま実行できる。
 *
 * 実行: cd backend && npm run build && node dist/src/scripts/reingest-all.js
 *   (ts-node直接実行はPrisma生成クライアントの.js拡張子importを解決できない)
 * 前提: RAGサービス(RAG_SERVICE_URL)が起動していること
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IngestStatus } from '../manual/model';
import { ManualService } from '../manual/service';
import { PrismaService } from '../prisma/service';

async function main() {
  // HTTPサーバーは立てず、DIコンテナだけを起動する
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  const prisma = app.get(PrismaService);
  const manuals = await prisma.manual.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true },
  });
  console.log(`対象: ${manuals.length}件`);

  // 1件ずつ直列に処理する。並列にするとBedrockのスロットリングと
  // RAGサービスの負荷を招くだけで、たいして速くならない
  const manualService = app.get(ManualService);
  let ok = 0;
  let failed = 0;
  for (const [i, m] of manuals.entries()) {
    process.stdout.write(`[${i + 1}/${manuals.length}] ${m.title} ... `);
    try {
      const chunkCount = await manualService.ingest(m.id);
      // ingest()は失敗を例外にせずDBステータスに記録する設計なので、
      // 戻り値だけでは成否が分からない。実行後のステータスで判定する
      const after = await prisma.manual.findUniqueOrThrow({
        where: { id: m.id },
        select: { ingestStatus: true, ingestError: true },
      });
      if (after.ingestStatus === IngestStatus.COMPLETED) {
        console.log(`OK (${chunkCount} chunks)`);
        ok += 1;
      } else {
        console.log(`FAILED: ${after.ingestError ?? '原因不明'}`);
        failed += 1;
      }
    } catch (e) {
      // 1件の失敗で全体を止めない。失敗はDB上FAILEDになるので
      // 管理画面の「再取り込み」からも個別に復旧できる
      console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
      failed += 1;
    }
  }

  console.log(`\n完了: 成功 ${ok}件 / 失敗 ${failed}件`);
  await app.close();
  process.exit(failed > 0 ? 1 : 0);
}

void main();
