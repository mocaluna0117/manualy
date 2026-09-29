import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { GqlAuthGuard } from './../src/auth/guard';
import { HealthController } from './../src/health/controller';

/**
 * AppModule全体を起動するとDB・Cognito・RAGサービスが必要になるため、
 * ここではALBヘルスチェック用のエンドポイントだけを対象にする。
 * (GraphQL側の検証は認証が絡むので、実環境に対するE2Eスクリプトで行っている)
 *
 * 重要: 本番と同じく**グローバル認証ガードを有効にした状態**で検証する。
 * @Public()を外すと401になりALBが全タスクを異常判定するため、
 * ガード無しでテストしても意味がない(それが実際に踏んだ落とし穴)。
 */
describe('HealthController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: GqlAuthGuard }],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /healthz は認証なしで200を返す(ALBヘルスチェック用)', () => {
    return request(app.getHttpServer())
      .get('/healthz')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
