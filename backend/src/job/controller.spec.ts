import { UnauthorizedException } from '@nestjs/common';
import type { ChatService } from '../chat/service';
import type { ManualService } from '../manual/service';
import { InternalJobController } from './controller';

/**
 * Cloud Tasks から叩かれる裏処理の入口。
 *
 * ここで固定したいのは2つ。
 * 1) トークンが未設定なら誰も通さない(fail closed)。取り込みはDBを
 *    書き換えるので、設定を忘れたら誰でも叩ける状態を作らない。
 * 2) 業務上の失敗でも2xxを返す。非2xxを返すと Cloud Tasks が
 *    数十分かかるPDFの取り込みを積み直し、同じPDFを二重に取り込む。
 */

const TOKEN = 'internal-secret';

function makeController(
  over: {
    runIngestFromJob?: jest.Mock;
    runReclassify?: jest.Mock;
    notify?: jest.Mock;
  } = {},
) {
  const runIngestFromJob =
    over.runIngestFromJob ?? jest.fn(() => Promise.resolve('done'));
  const runReclassify =
    over.runReclassify ?? jest.fn(() => Promise.resolve(null));
  const notify = over.notify ?? jest.fn(() => Promise.resolve());
  const controller = new InternalJobController(
    { runIngestFromJob, runReclassify } as unknown as ManualService,
    { notifyReclassifyFinished: notify } as unknown as ChatService,
  );
  return { controller, runIngestFromJob, runReclassify, notify };
}

const saved = process.env.INGEST_INTERNAL_TOKEN;

beforeEach(() => {
  process.env.INGEST_INTERNAL_TOKEN = TOKEN;
});

afterEach(() => {
  if (saved === undefined) delete process.env.INGEST_INTERNAL_TOKEN;
  else process.env.INGEST_INTERNAL_TOKEN = saved;
});

describe('内部エンドポイントの守り', () => {
  it('トークンが未設定なら、正しそうな値でも通さない', async () => {
    delete process.env.INGEST_INTERNAL_TOKEN;
    const { controller, runIngestFromJob } = makeController();

    await expect(
      controller.ingest('なんでも', { manualId: 'm1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(runIngestFromJob).not.toHaveBeenCalled();
  });

  it('トークンが違えば通さない', async () => {
    const { controller, runIngestFromJob } = makeController();

    await expect(
      controller.ingest('ちがう値', { manualId: 'm1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(runIngestFromJob).not.toHaveBeenCalled();
  });

  it('ヘッダが無ければ通さない', async () => {
    const { controller } = makeController();

    await expect(
      controller.ingest(undefined, { manualId: 'm1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('長さの違うトークンでも例外にならず、ただ拒否される', async () => {
    // timingSafeEqual は長さが違うと投げるので、比べる前に必ず
    // 同じ長さのハッシュにしている。500ではなく401で返ること
    const { controller } = makeController();

    await expect(
      controller.ingest('短い', { manualId: 'm1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('POST /internal/ingest', () => {
  it('取り込みを実行する', async () => {
    const { controller, runIngestFromJob } = makeController();
    const dispatchedAt = '2026-09-10T01:00:00.000Z';

    const res = await controller.ingest(TOKEN, {
      manualId: 'm1',
      autoCategorize: true,
      dispatchedAt,
    });

    expect(res).toEqual({ status: 'done' });
    expect(runIngestFromJob).toHaveBeenCalledWith(
      'm1',
      true,
      new Date(dispatchedAt),
    );
  });

  it('壊れた依頼は200で捨てる(積み直しても永久に成功しない)', async () => {
    const { controller, runIngestFromJob } = makeController();

    const res = await controller.ingest(TOKEN, {});

    expect(res).toEqual({ status: 'bad_request' });
    expect(runIngestFromJob).not.toHaveBeenCalled();
  });

  it('実行中に落ちても2xxで返す。積み直されると二重取り込みになる', async () => {
    const { controller } = makeController({
      runIngestFromJob: jest.fn(() => Promise.reject(new Error('DBが落ちた'))),
    });

    await expect(controller.ingest(TOKEN, { manualId: 'm1' })).resolves.toEqual(
      {
        status: 'error',
      },
    );
  });

  it('日時が読めないときは判定を諦めて実行する(取り込み漏れを作らない)', async () => {
    const { controller, runIngestFromJob } = makeController();

    await controller.ingest(TOKEN, { manualId: 'm1', dispatchedAt: 'ごみ' });

    expect(runIngestFromJob).toHaveBeenCalledWith('m1', false, undefined);
  });
});

describe('POST /internal/reclassify', () => {
  it('再分類を実行し、チャットから始めた分は会話へ書き戻す', async () => {
    const outcome = { ok: true, movedCount: 3 };
    const { controller, runReclassify, notify } = makeController({
      runReclassify: jest.fn(() =>
        Promise.resolve({ outcome, conversationId: 'conv-1' }),
      ),
    });

    const res = await controller.reclassify(TOKEN, { jobId: 'job-1' });

    expect(res).toEqual({ status: 'done' });
    expect(runReclassify).toHaveBeenCalledWith('job-1');
    expect(notify).toHaveBeenCalledWith('conv-1', outcome);
  });

  it('画面から始めた分(会話なし)は通知しない', async () => {
    const { controller, notify } = makeController({
      runReclassify: jest.fn(() =>
        Promise.resolve({ outcome: { ok: true }, conversationId: null }),
      ),
    });

    await controller.reclassify(TOKEN, { jobId: 'job-1' });

    expect(notify).not.toHaveBeenCalled();
  });

  it('既に終わっているジョブは何もしない', async () => {
    const { controller, notify } = makeController();

    await expect(
      controller.reclassify(TOKEN, { jobId: 'job-1' }),
    ).resolves.toEqual({ status: 'skipped' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('落ちても2xxで返す', async () => {
    const { controller } = makeController({
      runReclassify: jest.fn(() => Promise.reject(new Error('AIが落ちた'))),
    });

    await expect(
      controller.reclassify(TOKEN, { jobId: 'job-1' }),
    ).resolves.toEqual({ status: 'error' });
  });

  it('jobIdが無ければ200で捨てる', async () => {
    const { controller, runReclassify } = makeController();

    await expect(controller.reclassify(TOKEN, {})).resolves.toEqual({
      status: 'bad_request',
    });
    expect(runReclassify).not.toHaveBeenCalled();
  });
});
