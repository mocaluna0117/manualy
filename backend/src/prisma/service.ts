import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'fs';
import { PrismaClient } from '../../generated/prisma/client';
import { checkDatabaseTls } from '../config/db-tls';

function withoutSslMode(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }

    // TLSの検査はここで行う。**DBに繋ぐ経路は必ずここを通る**ため、
    // これ以外の場所に置くと覆いきれない。
    //
    // 以前は main.ts が最初にimportする config/load-secrets.ts に置いていたが、
    // それでは main.ts から起動するサーバー本体しか守れなかった。
    // src/scripts/ 配下(migrate-user-ids など)は自前で最小限のモジュールを
    // 組み立てて PrismaService を直接作るので、Supabaseを指していても
    // 無警告のまま平文/無検証で繋がっていた(実機で確認)。
    //
    // 黙って平文で繋ぐくらいなら起動しないほうがよい。CAはイメージに
    // 入っているので、直し方は「環境変数を1つ足す」だけで済む
    const tlsProblem = checkDatabaseTls();
    if (tlsProblem) {
      throw new Error(`[db-tls] ${tlsProblem}`);
    }

    // RDSのTLS証明書はAmazon独自のCAで署名されており、Nodeの標準信頼ストアには
    // 入っていない。そのため接続文字列に sslmode=require と書くだけでは
    // 「self-signed certificate in certificate chain」で接続が失敗する。
    //
    // rejectUnauthorized:false にすれば通るが、それでは経路は暗号化されても
    // 相手が本物のRDSかを確認できない(中間者攻撃を検知できない)。
    // CAを明示的に渡して「暗号化 + 証明書の検証」を両立させる。
    // ローカル開発(Dockerネットワーク内・TLSなし)では未設定なので何もしない。
    const caPath = process.env.DATABASE_SSL_CA;
    const adapter = new PrismaPg(
      caPath
        ? {
            // 接続文字列の sslmode は必ず取り除く。pgは接続文字列を後から解釈して
            // ssl設定を上書きするため、sslmode=require が残っているとCAを渡しても
            // ssl:{} に差し替えられ、結局「self-signed certificate」で失敗する。
            // (pgは require を verify-full 相当として扱うが、CAが無いので検証できない)
            connectionString: withoutSslMode(connectionString),
            ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true },
          }
        : { connectionString },
    );

    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
