import { HealthController } from './controller';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/**
 * 死活確認の口。
 *
 * 「/healthz」と「/health」の両方に応えることを固定する。
 * Cloud Run では /healthz が Google に横取りされてコンテナまで届かない
 * (実測。応答に server: Google Frontend が付かない)。一方 AWS の ALB は
 * /healthz を見ているので消せない。片方だけにすると、どちらかの環境で
 * 死活監視が黙って効かなくなる。
 */
describe('HealthController', () => {
  let app: INestApplication;

  /** supertest に渡すサーバー。getHttpServer() の戻りが any なので1箇所で受ける */
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('/healthz で応える(AWSのALBが見ている)', async () => {
    const res = await request(server()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('/health で応える(Cloud Runでは/healthzが届かないため)', async () => {
    const res = await request(server()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
