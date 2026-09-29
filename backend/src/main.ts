// 必ず1行目に置く。Secret Manager からマウントしたJSONを環境変数へ展開する。
// importは巻き上げられるので、ここより下に書くとAppModuleの読み込みが先に走り、
// PrismaService がコンストラクタで読む DATABASE_SSL_CA に間に合わない
import './config/load-secrets';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 応答をgzipで圧縮する。移行後は米国の Cloud Run から返すので、通信量が
  // 無料枠(北米発 1GB/月)に収まるかどうかがこれで決まる(JSONは5〜10倍縮む)。
  // チャットのストリーム(SSE)は圧縮すると途中で溜め込まれて流れなくなるので外す
  app.use(
    compression({
      filter: (req, res) =>
        req.path.startsWith('/chat/stream')
          ? false
          : compression.filter(req, res),
    }),
  );
  // 画像添付(base64)を受けるためJSONボディ上限を引き上げ(既定は100KB)。
  // base64は元より約1.34倍に膨らむので、質問に添える画像(4MB×4枚まで)が
  // 収まる大きさにしておく
  app.use(json({ limit: '24mb' }));
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  });
  // SIGTERM/SIGINTでNestのライフサイクルフックを動かす。
  // ECSはタスク停止時にSIGTERMを送るので、これが無いと終了処理が走らない
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
// 起動は最後の処理なので、失敗したらそのままプロセスを落とす(黙って起動済みに見せない)
bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
