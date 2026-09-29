import { BadRequestException } from '@nestjs/common';
import type { JobDispatcher } from '../job/dispatcher';
import type { PrismaService } from '../prisma/service';
import type { RagService } from '../rag/service';
import type { StorageService } from '../storage/service';
import { ManualService } from './service';

/**
 * 取り込み中(PROCESSING)のまま戻ってこない行を作らないこと。
 *
 * 一度この状態になると、画面は「取り込み中…」を出し続け、AI検索の対象にも
 * ならず、管理者が「再取り込み」を押しても何も起きない、という詰みになる。
 * 3人の検証者が独立に踏んだので、次に壊れたらここで落ちるようにしておく。
 *
 * 押さえたい約束は3つ。
 * 1) inline(AWS/ローカル)の起動直後は、updatedAtを見ずに全部FAILEDへ戻す。
 *    プロセスが落ちた時点で進行中の取り込みは1件も無いので、
 *    「3分前に動いていた」を理由に残してはいけない。
 * 2) 複数インスタンスになる構成と定期実行では、しばらく動きの無いものだけ。
 *    他のインスタンスで本当に進行中のものを横から潰さない。
 * 3) 掃除は起動時の1回では足りない。定期的に見に行く。
 */

type UpdateManyArgs = {
  where: {
    ingestStatus: string;
    updatedAt?: { lt: Date };
    /** 列で順番待ちのぶんを掃除から外すための除外リスト */
    id?: { notIn: string[] };
  };
  data: { ingestStatus: string; ingestError: string };
};

function setUp(mode: 'inline' | 'cloud_tasks') {
  const sweeps: UpdateManyArgs[] = [];
  const prisma = {
    manual: {
      updateMany: jest.fn((args: UpdateManyArgs) => {
        sweeps.push(args);
        return Promise.resolve({ count: 0 });
      }),
      findMany: jest.fn(() => Promise.resolve([])),
    },
  };
  const jobs = {
    register: jest.fn(),
    verifyConfig: jest.fn(),
    warmUpCredentials: jest.fn(() => Promise.resolve()),
    mode,
  };
  const service = new ManualService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as RagService,
    jobs as unknown as JobDispatcher,
  );
  return { service, sweeps, jobs };
}

describe('止まった取り込みの後始末', () => {
  afterEach(() => jest.useRealTimers());

  it('inline の起動直後は updatedAt を見ずに全部FAILEDへ戻す', async () => {
    const { service, sweeps } = setUp('inline');

    await service.onApplicationBootstrap();

    // 最初の1回が起動時の掃除
    expect(sweeps[0].where.ingestStatus).toBe('PROCESSING');
    // ここに updatedAt の絞り込みが入ると、落ちる3分前まで動いていた
    // 取り込みが対象から外れ、PROCESSINGのまま誰も直せなくなる
    expect(sweeps[0].where.updatedAt).toBeUndefined();
    expect(sweeps[0].data.ingestStatus).toBe('FAILED');
  });

  it('複数インスタンスになる構成では、動きの無いものだけを戻す', async () => {
    const { service, sweeps } = setUp('cloud_tasks');

    await service.onApplicationBootstrap();

    // 別のインスタンスで進行中のものを起動のたびに潰さない
    expect(sweeps[0].where.updatedAt?.lt).toBeInstanceOf(Date);
  });

  it('起動時の1回で終わらせず、そのあとも定期的に掃除する', async () => {
    jest.useFakeTimers();
    const { service, sweeps } = setUp('inline');

    await service.onApplicationBootstrap();
    const atBoot = sweeps.length;
    jest.advanceTimersByTime(6 * 60 * 1000);

    expect(sweeps.length).toBeGreaterThan(atBoot);
    // 定期実行では必ず「しばらく動きの無いものだけ」に絞る。
    // 無条件で戻すと、いま自分が流している取り込みを自分で潰してしまう
    expect(sweeps[atBoot].where.updatedAt?.lt).toBeInstanceOf(Date);
  });
});

/** claimIngest が取れなかったときに、画面へ理由を返すこと */
describe('startIngest', () => {
  function makeService(claimed: boolean) {
    const prisma = {
      manual: {
        findUnique: jest.fn(() => Promise.resolve({ id: 'm1' })),
        updateMany: jest.fn(() => Promise.resolve({ count: claimed ? 1 : 0 })),
      },
    };
    const dispatchIngest = jest.fn(() => Promise.resolve());
    const service = new ManualService(
      prisma as unknown as PrismaService,
      {} as StorageService,
      {} as RagService,
      { dispatchIngest } as unknown as JobDispatcher,
    );
    return { service, dispatchIngest };
  }

  it('取り込みを始められたら true を返して裏へ投げる', async () => {
    const { service, dispatchIngest } = makeService(true);

    await expect(service.startIngest('m1')).resolves.toBe(true);
    expect(dispatchIngest).toHaveBeenCalledTimes(1);
  });

  it('既に取り込み中なら理由を返す。trueを返すと「始めました」と出て何も起きない', async () => {
    const { service, dispatchIngest } = makeService(false);

    await expect(service.startIngest('m1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.startIngest('m1')).rejects.toThrow(/取り込み中/);
    expect(dispatchIngest).not.toHaveBeenCalled();
  });
});

/**
 * 列(inline の順番待ち)で待っているだけの行を、定期掃除で潰さないこと。
 *
 * startIngest は先にPROCESSINGを立ててから列に入れる。ところが updatedAt を
 * 進める heartbeat は runIngest の中でしか動かないので、前の1件が長引くと
 * 後ろの行は「claimした時刻のまま」20分の見切りを越える。5分ごとの掃除に
 * 拾われて FAILED +「取り込みが途中で止まりました(応答がありません)」に
 * なり、押した本人には何が起きたか分からない。
 * 自分の列に居ることは自分が知っているので、対象から外す。
 */
describe('列で順番待ちの取り込み', () => {
  afterEach(() => jest.useRealTimers());

  /** 1本目が返ってこないまま列が詰まっている状況を作る */
  function setUpQueue() {
    const sweeps: UpdateManyArgs[] = [];
    const prisma = {
      manual: {
        // claim(where に id)と掃除(where に id が無い)が同じ関数を通る
        updateMany: jest.fn((args: UpdateManyArgs) => {
          if (typeof (args.where as { id?: unknown }).id === 'string') {
            return Promise.resolve({ count: 1 }); // claim / heartbeat
          }
          sweeps.push(args);
          return Promise.resolve({ count: 0 });
        }),
        findUnique: jest.fn(() => Promise.resolve({ id: 'm1' })),
        // 1本目の取り込みが返ってこない(列が空かない)
        findUniqueOrThrow: jest.fn(() => new Promise(() => {})),
        update: jest.fn(() => Promise.resolve({})),
        findMany: jest.fn(() => Promise.resolve([])),
      },
    };
    const jobs: Record<string, unknown> = {
      verifyConfig: jest.fn(),
      warmUpCredentials: jest.fn(() => Promise.resolve()),
      mode: 'inline',
    };
    jobs.register = jest.fn((handlers: unknown) => {
      jobs.handlers = handlers;
    });
    jobs.dispatchIngest = jest.fn((id: string, autoCategorize: boolean) => {
      (jobs.handlers as { ingest: (i: string, a: boolean) => void }).ingest(
        id,
        autoCategorize,
      );
      return Promise.resolve();
    });
    const service = new ManualService(
      prisma as unknown as PrismaService,
      {} as StorageService,
      {} as RagService,
      jobs as unknown as JobDispatcher,
    );
    return { service, sweeps };
  }

  /** 列の .then() まで進める(タイマーではなくマイクロタスク) */
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('走り出していない行は定期掃除の対象から外す', async () => {
    jest.useFakeTimers();
    const { service, sweeps } = setUpQueue();
    await service.onApplicationBootstrap();

    // m1 が列を塞ぎ、m2 は順番待ちのまま
    await service.startIngest('m1');
    await flush();
    await service.startIngest('m2');
    await flush();

    const before = sweeps.length;
    jest.advanceTimersByTime(6 * 60 * 1000);
    const sweep = sweeps[before];

    expect(sweep).toBeDefined();
    // まだ走り出していない m2 は触らない。ここが空だと
    // 「順番待ちなだけの行」が FAILED にされる
    expect(sweep.where.id?.notIn).toContain('m2');
    // 走り出した m1 は heartbeat が updatedAt を進めるので、
    // 本当に固まったときは掃除の対象でよい
    expect(sweep.where.id?.notIn).not.toContain('m1');
  });
});
