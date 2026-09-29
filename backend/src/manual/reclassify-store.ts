import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { resolveDispatchMode } from '../job/dispatcher';
import type { PrismaService } from '../prisma/service';
import { EmptiedCategory, ReclassifyStatus } from './model';

/**
 * 全件再分類の進み具合をどこに置くか。
 *
 * これまではインスタンス内のメモリ(ManualServiceのフィールド)に置いていた。
 * Cloud Run はリクエストごとに別のインスタンスへ振り分けるので、
 * 開始したのとは別のインスタンスが進捗を聞かれると必ず
 * 「動いていません」と答えてしまい、進捗表示が壊れる。
 *
 * かといって無条件にDBの表へ移すことはできない。**AWS本番のRDSには
 * ReclassifyJob 表がまだ無い**(09-08取得のダンプで確認。表は12個で
 * ReclassifySnapshot はあるが ReclassifyJob は無い)。管理者のサイドバーは
 * reclassifyStatus を30秒ごとに叩くので、表が無いまま切り替えると
 * 切り替え日までの本番でエラーが出続ける。
 *
 * そこで保存先を環境変数で選べるようにし、**既定は memory** に倒す。
 * Cloud Run 側のデプロイで RECLASSIFY_STORE=db を明示する
 * (INGEST_DISPATCH が inline 以外なら自動的に db になるので、
 *  通常は明示すら要らない)。
 */
export interface ReclassifyOutcome {
  ok: boolean;
  movedCount: number;
  createdCategories: string[];
  emptiedCategories: EmptiedCategory[];
  movedToLocked: string[];
  skippedLocked: string[];
  /** ルールが食い違って動かさなかった件数(選んでもらう必要がある) */
  conflictedCount: number;
  error?: string;
}

/** 開始時に控えた入力。実処理を走らせるインスタンスがこれを読む */
export interface ReclassifyJobInput {
  instruction: string | null;
  conversationId: string | null;
  running: boolean;
}

export interface ReclassifyStore {
  /** 画面に出す最新の状態。1件も無くても既定値を返す(GraphQLがnon-null) */
  latest(): Promise<ReclassifyStatus>;
  /**
   * 開始を「1文で」宣言し、ジョブのIDを返す。既に走っていれば null。
   *
   * 「実行中か調べる」と「開始を記録する」を別の関数に分けてはいけない。
   * 分けると、そのあいだのDB往復(Cloud Run〜Supabaseはオレゴン間で数十ms)の
   * 隙間で両方が「空いている」と読み、ジョブ行が2つできて再分類が
   * 二重に走る。控え(ReclassifySnapshot)も2つできるため、
   * 「元に戻す」が最新の1件しか見ずに当てにならなくなる
   */
  tryStart(
    instruction?: string,
    conversationId?: string,
  ): Promise<string | null>;
  /** 実処理側が入力を読む。無ければnull */
  read(jobId: string): Promise<ReclassifyJobInput | null>;
  /** 完了(成功・失敗どちらも)を記録する */
  finish(jobId: string, outcome: ReclassifyOutcome): Promise<void>;
}

/**
 * 1件も無いときに返す値。
 *
 * フロントは running / movedCount / createdCategories / emptiedCategories /
 * movedToLocked / skippedLocked / error / finishedAt を non-null で受け取る。
 * null や例外を返すとサイドバー全体のトーストが荒れるので、
 * 「動いていない・何も起きていない」を必ず値で表現する
 */
export function emptyReclassifyStatus(): ReclassifyStatus {
  return {
    running: false,
    conflictedCount: 0,
    movedCount: 0,
    createdCategories: [],
    emptiedCategories: [],
    movedToLocked: [],
    skippedLocked: [],
    error: null,
    finishedAt: null,
  };
}

/**
 * running のまま取り残されたジョブを、これだけ経ったら「中断された」とみなす。
 *
 * Cloud Run のインスタンスが再分類の途中で落ちると、DBの行は running=true の
 * まま誰も終わらせない。そのままだと二度と再分類を始められなくなるので、
 * 十分に長い時間で見切る。再分類の実測は数分なので60分あれば足りる
 */
const RECLASSIFY_STALE_MINUTES = Number(
  process.env.RECLASSIFY_STALE_MINUTES ?? 60,
);

/**
 * 見切った(running のまま取り残された)ジョブに書き残す理由。
 *
 * 画面に出す latest() と、次の開始時に行を閉じる tryStart() の
 * 両方から使う。文言がずれると「同じことが2通りに見える」ので1か所に置く
 */
const RECLASSIFY_STALE_MESSAGE =
  '再分類の途中でサーバーが停止しました。もう一度実行してください';

/** JSON列から文字列の配列を取り出す(壊れていても画面を止めない) */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

/** JSON列から空になったフォルダの一覧を取り出す */
function toEmptiedCategories(value: unknown): EmptiedCategory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (typeof v !== 'object' || v === null) return [];
    const row = v as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.name !== 'string') return [];
    return [
      { id: row.id, name: row.name, createdByAi: row.createdByAi === true },
    ];
  });
}

/**
 * インスタンス内のメモリに置く版。これまでと同じ挙動。
 * 単一コンテナ(AWS/ローカル)ではこれで足りるし、表が無くても動く
 */
export class MemoryReclassifyStore implements ReclassifyStore {
  private job: {
    id: string;
    status: ReclassifyStatus;
    instruction: string | null;
    conversationId: string | null;
  } | null = null;

  latest(): Promise<ReclassifyStatus> {
    return Promise.resolve(
      this.job ? this.job.status : emptyReclassifyStatus(),
    );
  }

  tryStart(
    instruction?: string,
    conversationId?: string,
  ): Promise<string | null> {
    // 判定と登録のあいだで await しない。1つでも挟むと、その隙に
    // もう一方の呼び出しが「動いていない」と読んで両方が始まる。
    // 同じプロセスの中でも、並行に走る2つの Promise では実際に起きる
    if (this.job?.status.running === true) return Promise.resolve(null);
    const id = randomUUID();
    this.job = {
      id,
      status: { ...emptyReclassifyStatus(), running: true },
      instruction: instruction ?? null,
      conversationId: conversationId ?? null,
    };
    return Promise.resolve(id);
  }

  read(jobId: string): Promise<ReclassifyJobInput | null> {
    if (!this.job || this.job.id !== jobId) return Promise.resolve(null);
    return Promise.resolve({
      instruction: this.job.instruction,
      conversationId: this.job.conversationId,
      running: this.job.status.running,
    });
  }

  finish(jobId: string, outcome: ReclassifyOutcome): Promise<void> {
    if (!this.job || this.job.id !== jobId) return Promise.resolve();
    this.job.status = {
      running: false,
      conflictedCount: outcome.conflictedCount,
      movedCount: outcome.movedCount,
      createdCategories: outcome.createdCategories,
      emptiedCategories: outcome.emptiedCategories,
      movedToLocked: outcome.movedToLocked,
      skippedLocked: outcome.skippedLocked,
      error: outcome.ok ? null : (outcome.error ?? '不明なエラー'),
      // 完了しても値を消さない。フロントは running が true→false に
      // 変わったレスポンスの中身を読んでトーストを出すため、
      // 「終わったら空にする」実装にすると通知が空になる
      finishedAt: new Date(),
    };
    return Promise.resolve();
  }
}

/** ReclassifyJob 表に置く版。Cloud Run のように複数インスタンスになる構成で使う */
export class DbReclassifyStore implements ReclassifyStore {
  constructor(private readonly prisma: PrismaService) {}

  private staleBefore() {
    return new Date(Date.now() - RECLASSIFY_STALE_MINUTES * 60 * 1000);
  }

  async latest(): Promise<ReclassifyStatus> {
    const row = await this.prisma.reclassifyJob.findFirst({
      orderBy: { startedAt: 'desc' },
    });
    if (!row) return emptyReclassifyStatus();
    const stale = row.running && row.startedAt < this.staleBefore();
    return {
      running: row.running && !stale,
      conflictedCount: row.conflictedCount,
      movedCount: row.movedCount,
      createdCategories: toStringArray(row.createdCategories),
      emptiedCategories: toEmptiedCategories(row.emptiedCategories),
      movedToLocked: toStringArray(row.movedToLocked),
      skippedLocked: toStringArray(row.skippedLocked),
      // 落ちたまま放置された分は、黙って「終わった」ことにしない。
      // 理由が出ればもう一度実行すればよいと分かる
      error: stale ? RECLASSIFY_STALE_MESSAGE : row.error,
      finishedAt: row.finishedAt,
    };
  }

  async tryStart(
    instruction?: string,
    conversationId?: string,
  ): Promise<string | null> {
    const stale = this.staleBefore();
    try {
      return await this.startInTransaction(instruction, conversationId, stale);
    } catch (e) {
      // 部分ユニーク索引(ReclassifyJob_running_key)に弾かれたときは、
      // 「誰かが既に走らせている」が事実なので null を返す。
      //
      // このアプリを通る限り助言ロックで直列化されるので普通は起きないが、
      // psqlや別のスクリプトから直接 running=true を入れられると起きる。
      // 索引はそれを防ぐために足したもので、例外をそのまま投げ返すと
      // 呼び出し側(service.ts の startReclassifyAll)の try の外なので、
      // サイドバーにPrismaの生のエラー文が出てしまう
      if (isUniqueViolation(e)) return null;
      throw e;
    }
  }

  /** tryStart の本体。例外の扱いを外に出すために分けている */
  private startInTransaction(
    instruction: string | undefined,
    conversationId: string | undefined,
    stale: Date,
  ): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      // 「調べる」と「作る」を1つのトランザクションに閉じ込め、そのあいだ
      // 他の呼び出しを待たせる。表そのものをロックすると、30秒ごとに来る
      // 進捗の読み取りまで止まってしまうので助言(advisory)ロックを使う。
      // xact 版はトランザクションが終われば必ず外れるので、途中で
      // インスタンスが落ちてもロックが残らない。
      // 鍵の番号は他と衝突しなければ何でもよい(切り替え日を使っている)。
      //
      // $queryRaw ではなく $executeRaw を使う。pg_advisory_xact_lock の
      // 戻り値の型は void で、$queryRaw は返ってきた列を必ずPrismaの型へ
      // 直そうとするため「Failed to deserialize column of type 'void'」で
      // **必ず**失敗する(実DBで再現。tryStart が100%例外になり、
      // ReclassifyJob の行は1つもできず、画面には
      // 「再分類を開始できませんでした: Raw query failed...」が出ていた)。
      // $executeRaw は結果を読まないので、そのまま流せる
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260916)`;
      const running = await tx.reclassifyJob.findFirst({
        // 落ちたまま放置された行で永久に塞がれないよう、latest() と
        // 同じ見切り(RECLASSIFY_STALE_MINUTES)を使う
        where: { running: true, startedAt: { gte: stale } },
        select: { id: true },
      });
      if (running) return null;
      // 見切った行は、次を作る前にここで閉じる。
      //
      // running=true の行が2つ並ぶと、部分ユニーク索引
      // (ReclassifyJob_running_key。移行 20260910120000 で追加)に弾かれて
      // 二度と再分類を始められなくなる。閉じておけば理由も残る
      await tx.reclassifyJob.updateMany({
        where: { running: true },
        data: {
          running: false,
          error: RECLASSIFY_STALE_MESSAGE,
          finishedAt: new Date(),
        },
      });
      const row = await tx.reclassifyJob.create({
        data: {
          running: true,
          instruction: instruction ?? null,
          conversationId: conversationId ?? null,
        },
        select: { id: true },
      });
      return row.id;
    });
  }

  async read(jobId: string): Promise<ReclassifyJobInput | null> {
    const row = await this.prisma.reclassifyJob.findUnique({
      where: { id: jobId },
      select: { instruction: true, conversationId: true, running: true },
    });
    return row ?? null;
  }

  async finish(jobId: string, outcome: ReclassifyOutcome): Promise<void> {
    await this.prisma.reclassifyJob.update({
      where: { id: jobId },
      data: {
        running: false,
        conflictedCount: outcome.conflictedCount,
        movedCount: outcome.movedCount,
        createdCategories: outcome.createdCategories,
        emptiedCategories:
          outcome.emptiedCategories as unknown as Prisma.InputJsonValue,
        movedToLocked: outcome.movedToLocked,
        skippedLocked: outcome.skippedLocked,
        error: outcome.ok ? null : (outcome.error ?? '不明なエラー'),
        finishedAt: new Date(),
      },
    });
  }
}

/**
 * 保存先を決める。
 *
 * 明示が無ければ「裏処理の投げ先が inline かどうか」で決める。
 * inline = 単一プロセスで完結する構成(AWS/ローカル)なのでメモリで足りるし、
 * AWS本番には表が無いのでメモリでなければ壊れる。
 */
export function createReclassifyStore(prisma: PrismaService): ReclassifyStore {
  const choice =
    process.env.RECLASSIFY_STORE ??
    (resolveDispatchMode() === 'inline' ? 'memory' : 'db');
  return choice === 'db'
    ? new DbReclassifyStore(prisma)
    : new MemoryReclassifyStore();
}

/**
 * 一意制約に弾かれた例外か。
 *
 * Prismaのエラーは instanceof で見分けようとすると、生成クライアントの
 * 実体を取り違えたときに黙って false になる。コード(P2002)で見る
 */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

/** 何も起きていない結果。失敗を記録するときの土台にする */
export function emptyReclassifyOutcome(): ReclassifyOutcome {
  return {
    ok: true,
    movedCount: 0,
    createdCategories: [],
    emptiedCategories: [],
    movedToLocked: [],
    skippedLocked: [],
    conflictedCount: 0,
  };
}
