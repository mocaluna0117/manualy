import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { JobDispatcher } from '../job/dispatcher';
import { PrismaService } from '../prisma/service';
import { RagService } from '../rag/service';
import { fileTypeOf } from '../storage/file-types';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';
import {
  createReclassifyStore,
  emptyReclassifyOutcome,
  emptyReclassifyStatus,
  type ReclassifyOutcome,
  type ReclassifyStore,
} from './reclassify-store';
import { looseMatch } from './title-match';
import { IngestStatus, ReclassifyStatus, RegisterOutcome } from './model';

/** ゴミ箱に入っていない(生きている)マニュアルだけを対象にする条件 */
const ALIVE = { deletedAt: null } as const;

/**
 * AIの分類に渡す本文の長さ(文字)。
 *
 * 以前は先頭120文字だけだった。分類ルールが「スライド1枚目の下部に
 * ※〇〇と併用する と書かれているファイル」のように表紙の脚注を指すことがあり、
 * その文言は実測で146〜186文字目にあって毎回切り落とされていた
 * (ルールを登録しても効かない、という報告につながった)。
 * 表紙1枚ぶんが丸ごと入る長さにする
 */
const CLASSIFY_SNIPPET_CHARS = 400;

/** ゴミ箱の自動削除までの日数 */
const TRASH_RETENTION_DAYS = 30;

/**
 * 取り込み中(PROCESSING)のまま、これだけ動きが無ければ「死んだ」とみなす分数。
 *
 * Cloud Run は毎朝コールドスタートし、負荷で複数インスタンスに増える。
 * 起動のたびに PROCESSING を全部 FAILED へ戻していると、別のインスタンスで
 * 進行中の取り込みを横から潰してしまう。実際に動いているものは
 * runIngest が定期的に updatedAt を進めるので、古いものだけを対象にする
 */
const INGEST_STALE_MINUTES = Number(process.env.INGEST_STALE_MINUTES ?? 20);

/**
 * 取り込み中に updatedAt を進める間隔。
 * 上の閾値(既定20分)に対して十分に短くしておく
 */
const INGEST_TOUCH_MS = 5 * 60 * 1000;

/**
 * 止まった取り込みを掃除しに行く間隔。
 *
 * 起動時の1回だけでは足りない。長く生き続けるインスタンス(AWSのECSは
 * 数日そのまま)では、その1回を過ぎたあとに固まった行を誰も直せない。
 * heartbeat と同じ5分ごとに見て、閾値(既定20分)を過ぎたものを戻す
 */
const INGEST_SWEEP_MS = 5 * 60 * 1000;

@Injectable()
export class ManualService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ManualService.name);

  /** 全件再分類の進み具合の置き場所(メモリ or ReclassifyJob表) */
  private readonly reclassifyStore: ReclassifyStore;

  /**
   * 完了したら呼ぶコールバック。inline のときだけ使う。
   *
   * Cloud Tasks 経由では実処理が別のインスタンスで走るので、
   * 開始した側のメモリに置いたコールバックは呼びようがない。
   * その場合の完了通知は ReclassifyJob.conversationId を見て
   * 実行した側(内部エンドポイント)が書き込む
   */
  private readonly reclassifyCallbacks = new Map<
    string,
    (result: ReclassifyOutcome) => void
  >();

  /**
   * 最後に読み取れた再分類の状態。
   *
   * 進行状況の読み取りに失敗したときの返り値に使う。読めなかったことを
   * 「何も起きていない」と取り違えると、走っている最中に完了トーストが出る
   */
  private lastReclassifyStatus: ReclassifyStatus | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly rag: RagService,
    private readonly jobs: JobDispatcher,
  ) {
    this.reclassifyStore = createReclassifyStore(prisma);
  }

  /**
   * 起動時に「取り込み中(PROCESSING)」で止まっている行を失敗扱いに戻す。
   *
   * 取り込みはfire-and-forgetで走るため、途中で再起動・デプロイ・OOMが起きると
   * PROCESSINGのまま永久に残り、AI検索の対象にならないまま画面が
   * 「取り込み中…」を出し続ける(ポーリングも止まらない)。
   * FAILEDにしておけば管理者が「再取り込み」で復旧できる。
   */
  async onApplicationBootstrap() {
    // 裏処理の実体を JobDispatcher に差し込む。DIで JobDispatcher から
    // ManualService を参照すると循環するので、呼ばれる側から登録する
    this.jobs.register({
      ingest: (manualId, autoCategorize) =>
        this.enqueueIngestInline(manualId, autoCategorize),
      reclassify: (jobId) => this.runReclassify(jobId),
    });
    // 宛先やトークンが足りないまま Cloud Run へ上げると、取り込みが
    // 全部行方不明になる。黙って壊れるより起動を止めて気づく
    this.jobs.verifyConfig();
    await this.jobs.warmUpCredentials();

    // 取り込みが同じプロセスの中でしか走らない構成(inline)では、
    // プロセスが立ち上がった時点で「進行中の取り込み」は1件も無い。
    // だから updatedAt を見ずに全部戻してよいし、そうしないと直せない
    await this.failStuckIngests({
      onlyStale: this.jobs.mode !== 'inline',
      reason:
        'サーバーの再起動により取り込みが中断されました。再取り込みしてください',
    });

    await this.rescueLostManuals();

    // 掃除は起動時の1回では足りない。ECSは数日、Cloud Runも混んでいる間は
    // 同じインスタンスが生き続けるので、その間に固まった行を誰も直せなくなる。
    // 定期実行では必ず「しばらく動きの無いものだけ」に絞る(自分のプロセスで
    // 進行中の取り込みを横から潰さないため)
    setInterval(
      () =>
        void this.failStuckIngests({
          onlyStale: true,
          reason:
            '取り込みが途中で止まりました(応答がありません)。再取り込みしてください',
        }).catch(() => undefined),
      INGEST_SWEEP_MS,
    ).unref();

    // ゴミ箱の自動削除。起動時に1回と、その後は1日ごと
    void this.purgeExpiredTrash().catch(() => undefined);
    setInterval(
      () => void this.purgeExpiredTrash().catch(() => undefined),
      24 * 60 * 60 * 1000,
    ).unref();
  }

  /**
   * 取り込み中(PROCESSING)のまま進まなくなった行をFAILEDへ戻す。
   *
   * onlyStale=false は「取り込みがこのプロセスの中でしか走らない」構成
   * (inline = AWS/ローカル)の起動直後だけに使う。プロセスが落ちた時点で
   * 進行中の取り込みは1件も残っていないので、無条件に戻してよい。
   * ここで updatedAt を見てしまうと、10:00に始まって10:03に落ちた取り込みが
   * 「3分前まで動いていた」ために対象から外れ、PROCESSINGのまま
   * どこからも直せなくなる(そのぶん画面は永久に「取り込み中」と出る)。
   *
   * onlyStale=true は複数インスタンスになる構成(Cloud Run)と、定期実行で使う。
   * 他のインスタンスで本当に進行中のものを横から潰さないよう、
   * heartbeat が止まって INGEST_STALE_MINUTES を過ぎたものだけを戻す。
   */
  private async failStuckIngests(options: {
    onlyStale: boolean;
    reason: string;
  }) {
    // 列(inline の順番待ち)でまだ走り出していない分は、絶対に触らない。
    //
    // startIngest は先にPROCESSINGを立ててから列に入れるが、updatedAtを
    // 進める heartbeat は runIngest の中でしか動かない。inline は1本ずつ
    // 直列なので、前の1件が長引くと後ろの行はPROCESSINGのまま20分の
    // 見切りを越え、5分ごとのこの掃除に「応答がありません」と潰される
    // (実DBで再現。列の2件目が FAILED になった)。
    // 自分の列に居ることは自分が知っているのだから、対象から外す
    const waiting = [...this.waitingIngests.keys()];
    const { count } = await this.prisma.manual.updateMany({
      where: {
        ingestStatus: IngestStatus.PROCESSING,
        ...(options.onlyStale
          ? {
              updatedAt: {
                lt: new Date(Date.now() - INGEST_STALE_MINUTES * 60 * 1000),
              },
            }
          : {}),
        ...(waiting.length > 0 ? { id: { notIn: waiting } } : {}),
      },
      data: {
        ingestStatus: IngestStatus.FAILED,
        ingestError: options.reason,
      },
    });
    if (count > 0) {
      this.logger.warn(`中断された取り込みを${count}件FAILEDに戻しました`);
    }
    return count;
  }

  /**
   * ゴミ箱の中のフォルダに入ってしまい、画面のどこにも出てこなくなった
   * マニュアルを未分類へ戻す。
   *
   * サイドバーはゴミ箱のフォルダを出さず、カテゴリが付いているので未分類にも出ず、
   * マニュアル自体は生きているのでゴミ箱にも出ない、という三重の死角になる。
   * 一方で重複チェックには引っかかるため「どこにも無いのに同名だと言われる」。
   * 割り当て側は塞いだので、これは既存データの後始末。
   */
  private async rescueLostManuals() {
    // updateManyはリレーション条件を書けないので、先にIDを集める
    const lost = await this.prisma.manual.findMany({
      where: { ...ALIVE, category: { deletedAt: { not: null } } },
      select: { id: true, title: true },
    });
    if (lost.length === 0) return;
    await this.prisma.manual.updateMany({
      where: { id: { in: lost.map((m) => m.id) } },
      data: { categoryId: null },
    });
    this.logger.warn(
      `ゴミ箱のフォルダに入っていたマニュアル${lost.length}件を未分類に戻しました: ` +
        lost.map((m) => m.title).join(', '),
    );
  }

  /**
   * 鍵付き(管理者だけに見せる)フォルダの中身を隠すための条件。
   *
   * 未分類(categoryIdがnull)は誰でも見えるので、そのままにする。
   * 呼び出し側が権限を渡し忘れても隠れる側に倒すため、既定はfalse。
   *
   * 配列で返してAND句へ入れる。オブジェクトのまま where に展開する形だと、
   * 同じwhereでOR句を使う検索(キーワード検索)で後から書いたORに
   * 上書きされ、除外が黙って消える。実際にそれでMEMBERにも
   * 鍵付きの題名と本文抜粋が出ていたので、構造的に起きない形にする
   */
  private visibleTo(includeAdminOnly: boolean): Prisma.ManualWhereInput[] {
    return includeAdminOnly
      ? []
      : [{ OR: [{ categoryId: null }, { category: { adminOnly: false } }] }];
  }

  findAll(
    categoryId?: string,
    uncategorized?: boolean,
    includeAdminOnly = false,
  ) {
    return this.prisma.manual.findMany({
      // uncategorized=trueなら「カテゴリ未設定」だけに絞る(nullでの絞り込み)
      where: uncategorized
        ? { ...ALIVE, categoryId: null }
        : categoryId
          ? { ...ALIVE, categoryId, AND: this.visibleTo(includeAdminOnly) }
          : { ...ALIVE, AND: this.visibleTo(includeAdminOnly) },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** キーワード検索。タイトル/説明/ファイル名/本文(チャンク)を部分一致で探す */
  async search(keyword: string, includeAdminOnly = false) {
    const kw = keyword.trim();
    if (!kw) return [];

    // mode: 'insensitive' = 大文字小文字を区別しない(ILIKE)
    const contains = { contains: kw, mode: 'insensitive' as const };
    const manuals = await this.prisma.manual.findMany({
      where: {
        ...ALIVE,
        // 見える範囲の条件と、キーワードの条件はどちらもORを使う。
        // 同じ階層に並べると後に書いた方が前を上書きするため、ANDで束ねる
        AND: [
          ...this.visibleTo(includeAdminOnly),
          {
            OR: [
              { title: contains },
              { fileName: contains },
              { chunks: { some: { content: contains } } },
            ],
          },
        ],
      },
      include: {
        // 本文がヒットした場合に備えて、最初にマッチしたチャンクを1つだけ取る
        chunks: {
          where: { content: contains },
          orderBy: { chunkIndex: 'asc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return manuals.map((manual) => ({
      manual,
      snippet: manual.chunks[0]
        ? this.makeSnippet(manual.chunks[0].content, kw)
        : null,
    }));
  }

  /** ヒット箇所の前後を切り出した抜粋を作る */
  private makeSnippet(content: string, keyword: string, radius = 60) {
    const index = content.toLowerCase().indexOf(keyword.toLowerCase());
    if (index < 0) return content.slice(0, radius * 2);
    const start = Math.max(0, index - radius);
    const end = Math.min(content.length, index + keyword.length + radius);
    const head = start > 0 ? '…' : '';
    const tail = end < content.length ? '…' : '';
    return `${head}${content.slice(start, end)}${tail}`;
  }

  /**
   * アップロード済みファイルのメタデータを登録する。
   * 同名(fileName一致)のマニュアルが既にある場合は最終更新日で新旧を判定し、
   * 新しい方だけを残す(古いものをアップロードした場合は取り込まない)。
   */
  async register(input: RegisterManualInput) {
    // autoCategorize/forceReplaceはDBの列ではないので分離する
    const { autoCategorize, forceReplace, ...data } = input;

    // macOSではファイル名がNFD(濁点・半濁点が結合文字。「パ」=「ハ」+「゚」)で
    // 届くため、そのまま保存すると検索側(NFCで入力される)の部分一致に当たらない。
    // 入口でNFCに揃える。同名判定(fileName一致)が正しく効くためにも必要
    data.title = data.title.normalize('NFC');
    data.fileName = data.fileName.normalize('NFC');

    const existing = await this.prisma.manual.findFirst({
      // ゴミ箱の中とは突き合わせない(捨てたものを差し替え対象にしない)
      where: { ...ALIVE, fileName: data.fileName },
      orderBy: { createdAt: 'desc' },
    });

    // 同名が無ければ通常の新規追加
    if (!existing) {
      const manual = await this.prisma.manual.create({ data });
      // 取り込みは裏で実行する。ユーザーを何十秒も待たせないため、
      // 取り込み本体は待たずに即レスポンスを返し、進行状況はingestStatusで見せる。
      // 「裏へ投げる」ところだけは待つ(投げ損ねたらFAILEDとして残すため)
      await this.enqueueIngest(manual.id, autoCategorize ?? false);
      return { manual, outcome: RegisterOutcome.CREATED };
    }

    // 新旧の判定に使う「元ファイルの最終更新日」。
    // 既存側がnullのケース(この機能より前に登録されたマニュアル)は「不明」として扱う。
    // 登録日時(createdAt)で代用してはいけない: それはアップロードした時刻であって
    // ファイルの更新日ではないため、必ず「既存の方が新しい」と誤判定してしまう
    const existingTime = existing.fileLastModified?.getTime();
    const incomingTime = data.fileLastModified?.getTime();
    const compared = {
      existingFileLastModified: existing.fileLastModified,
      incomingFileLastModified: data.fileLastModified ?? null,
    };

    // どちらかの更新日が不明なら比較できない。
    // 利用者は「このファイルで更新したい」という意図でアップロードしているので、
    // 判断できない場合は差し替える(重複を増やさない・意図を尊重する)
    const canCompare = existingTime !== undefined && incomingTime !== undefined;

    // 既存の方が新しい(または同時刻)なら取り込まない
    if (!forceReplace && canCompare && incomingTime <= existingTime) {
      // アップロード済みの実ファイルは迷子になるので消す。
      // ただし既存と同じキーを送ってきた場合に本体を消さないよう必ず確認する
      if (data.fileKey !== existing.fileKey) {
        await this.storage.deleteObject(data.fileKey).catch(() => undefined);
      }
      return {
        manual: existing,
        outcome: RegisterOutcome.SKIPPED_OLDER,
        ...compared,
      };
    }

    // 差し替える: 既存を同じIDのまま更新する。
    // IDを保つことで、過去の会話に残った引用リンクも生き続ける
    const oldFileKey = existing.fileKey;
    const manual = await this.prisma.$transaction(async (tx) => {
      // 旧版のチャンクは必ずここで消す。残すと取り込みが失敗した場合に
      // 「新しいPDFに差し替わったのに、AIは旧版の内容で回答する」状態になる
      await tx.manualChunk.deleteMany({ where: { manualId: existing.id } });
      return tx.manual.update({
        where: { id: existing.id },
        data: {
          title: data.title,
          // カテゴリは未指定なら既存の設定を維持する
          categoryId: data.categoryId ?? existing.categoryId,
          fileKey: data.fileKey,
          fileName: data.fileName,
          fileLastModified: data.fileLastModified,
          size: data.size,
          // 中身が変わったので取り込みをやり直す
          ingestStatus: IngestStatus.PENDING,
          ingestError: null,
          chunkCount: null,
          ingestedAt: null,
        },
      });
    });
    // 旧ファイルはもう参照されないので削除(失敗しても登録は成功扱い)
    if (oldFileKey !== data.fileKey) {
      await this.storage.deleteObject(oldFileKey).catch(() => undefined);
    }
    await this.enqueueIngest(manual.id, autoCategorize ?? false);
    return { manual, outcome: RegisterOutcome.UPDATED, ...compared };
  }

  /** 手動での(再)取り込み。FAILEDになったマニュアルのリトライ用 */
  /** 取り込みを最後まで待つ(一括再取り込みスクリプト用) */
  async ingest(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    await this.runIngest(id);
    const updated = await this.prisma.manual.findUniqueOrThrow({
      where: { id },
    });
    return updated.chunkCount ?? 0;
  }

  /**
   * 取り込みを裏で開始し、すぐ返す(画面から押す「再取り込み」用)。
   * スキャンPDFの書き起こしがあると数分かかりALBのタイムアウトを超えるため、
   * 待たせずに進行状況をDBのステータスで見せる。
   * 先にPROCESSINGへ変えておくことで、呼び出し直後の一覧に「取り込み中」が出る
   */
  async startIngest(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    // 「今から取り込む」の宣言。取れなければ既に誰かが流している。
    //
    // 以前はここで true を返していたが、画面には「始めました」と出るのに
    // 実際には何も投げられず、利用者は何度押しても無反応に見えた。
    // 理由を返して「すでに取り込み中です」と出せるようにする
    if (!(await this.claimIngest(id))) {
      this.logger.warn(`既に取り込み中なので二重には流しません manual=${id}`);
      throw new BadRequestException(
        'すでに取り込み中です。終わるまでお待ちください',
      );
    }
    await this.enqueueIngest(id);
    return true;
  }

  /**
   * 「今から自分が取り込む」と宣言する。既に取り込み中なら false。
   *
   * 判定と更新は必ず1文で行う。分けて書くと、続けて2回押されたときに
   * 両方が「空いている」と読んでから両方が書き込み、同じPDFを二重に流す。
   * 死んだインスタンスが握ったままのPROCESSINGは、しばらく動きが無ければ
   * 奪ってよい(起動時の掃除と同じ閾値を使う)
   */
  private async claimIngest(id: string) {
    const stale = new Date(Date.now() - INGEST_STALE_MINUTES * 60 * 1000);
    const { count } = await this.prisma.manual.updateMany({
      where: {
        id,
        OR: [
          { ingestStatus: { not: IngestStatus.PROCESSING } },
          { updatedAt: { lt: stale } },
        ],
      },
      data: { ingestStatus: IngestStatus.PROCESSING, ingestError: null },
    });
    return count === 1;
  }

  /**
   * 取り込みの順番待ち(inline のときだけ使う)。
   *
   * 取り込みはPDFの解析と埋め込みで重く、RAGは0.5 vCPU/1GBの1タスクしかない。
   * まとめてアップロードすると同時に何本も流れ込み、RAGが応答できなくなって
   * ヘルスチェックに落ち、ECSに停止させられる(実際に11件同時で全滅した)。
   * 1本ずつ順番に流して、詰まらせない。
   *
   * 同じプロセスの中でしか効かないので、複数インスタンスになる Cloud Run では
   * この列に代えて Cloud Tasks のキュー側で直列にする
   * (maxConcurrentDispatches=1)。守りたい性質は同じ:
   * 「RAGへ同時に1本しか流さない」
   */
  private ingestQueue: Promise<unknown> = Promise.resolve();

  /**
   * 列に入っているが、まだ走り出していないマニュアルのID。
   *
   * 定期掃除(failStuckIngests)の対象から外すために持つ。列で待っている間は
   * heartbeat が動かないので、updatedAt は claim した時刻のまま止まる。
   * 前の1件が20分を超えると、後ろの行が「応答がありません」で潰される。
   *
   * 件数で持つのは、同じマニュアルが2回列に入りうるため
   * (更新アップロードは claimIngest を通らずに投げ直す)。
   * Setにすると1本目が走り出した時点で2本目の分まで守りが外れる
   */
  private readonly waitingIngests = new Map<string, number>();

  /**
   * inline のときの取り込み。今までどおり同じプロセスの順番待ちに入れる
   * (呼び出し側は待たない)
   */
  private enqueueIngestInline(id: string, autoCategorize = false) {
    this.waitingIngests.set(id, (this.waitingIngests.get(id) ?? 0) + 1);
    this.ingestQueue = this.ingestQueue
      .catch(() => undefined) // 前の失敗で列を止めない
      .then(() => {
        // 走り出したらこの先は heartbeat が updatedAt を進めるので、
        // ここで札を返す。runIngest は最初の await より前に
        // heartbeat の setInterval を張るため、隙間はできない
        const left = (this.waitingIngests.get(id) ?? 1) - 1;
        if (left > 0) this.waitingIngests.set(id, left);
        else this.waitingIngests.delete(id);
        return this.runIngest(id, autoCategorize);
      });
  }

  /**
   * 取り込みを裏へ投げる。投げ先(同じプロセス / Cloud Tasks / 自分へHTTP)は
   * JobDispatcher が決める。
   *
   * 投げること自体に失敗したらFAILEDとして残す。ここで例外を投げると
   * アップロード直後のGraphQLごと落ち、ファイルだけ上がって行方不明になる。
   * 理由がDBに残っていれば、管理者が「再取り込み」でやり直せる
   */
  private async enqueueIngest(id: string, autoCategorize = false) {
    try {
      await this.jobs.dispatchIngest(id, autoCategorize);
    } catch (e) {
      const message = e instanceof Error ? e.message : '不明なエラー';
      this.logger.error(`取り込みの登録に失敗 manual=${id}: ${message}`);
      await this.prisma.manual
        .update({
          where: { id },
          data: {
            ingestStatus: IngestStatus.FAILED,
            ingestError: `取り込みを開始できませんでした: ${message}`,
          },
        })
        .catch(() => undefined);
    }
  }

  /**
   * 内部エンドポイント(Cloud Tasks / self_http)から呼ばれる取り込み。
   *
   * 例外を投げない。呼び出し側は必ず2xxを返す約束で、非2xxを返すと
   * Cloud Tasks が数十分かかるPDFの取り込みをまるごと積み直してしまう
   */
  async runIngestFromJob(
    manualId: string,
    autoCategorize: boolean,
    dispatchedAt?: Date,
  ): Promise<'done' | 'not_found' | 'already_done' | 'already_running'> {
    const manual = await this.prisma.manual.findUnique({
      where: { id: manualId },
      select: { ingestStatus: true, ingestedAt: true, updatedAt: true },
    });
    // 消されたマニュアルの取り込みは、やり直しても永久に失敗する。
    // 200で終わらせて積み直させない
    if (!manual) return 'not_found';
    // 同じタスクが配り直されたときに、終わっている仕事をやり直さない。
    // 「このタスクを積んだ後に完了している」なら、それはこのタスクの成果
    if (
      dispatchedAt &&
      manual.ingestStatus === IngestStatus.COMPLETED &&
      manual.ingestedAt &&
      manual.ingestedAt > dispatchedAt
    ) {
      return 'already_done';
    }
    // 誰かが既に同じマニュアルを流している最中なら手を出さない。
    //
    // キューは maxConcurrentDispatches=1 で作るので普通は起きないが、
    // 「本当に直列になるか」はまだ実機で確かめられていない(宛先のサービスが
    // まだ無い)。設定だけに頼らず、受け側でも重なりを防いでおく。
    //
    // 判定は「取り込み中」だけでは足りない。startIngest はタスクを積む前に
    // PROCESSING を立てるので、それだけだと自分の仕事まで捨ててしまう。
    // このタスクを積んだ**後に**動きがあった場合に限って、別の誰かが
    // 先に始めたと判断する(積む前の更新は自分が立てた印)
    if (
      dispatchedAt &&
      manual.ingestStatus === IngestStatus.PROCESSING &&
      manual.updatedAt > dispatchedAt
    ) {
      this.logger.warn(
        `既に別の実行が進んでいるため取り込みを見送ります manual=${manualId}`,
      );
      return 'already_running';
    }
    await this.runIngest(manualId, autoCategorize);
    return 'done';
  }

  private async runIngest(id: string, autoCategorize = false) {
    // 取り込みの最中は updatedAt を定期的に進める。
    //
    // runIngest は開始時と rag.ingest の完了後にしか manual を更新しない。
    // スキャンPDFの書き起こしを挟むと数十分かかることがあり、その間
    // updatedAt が止まって見えるので、別インスタンスの起動時の掃除に
    // 「もう死んでいる」と判断されFAILEDへ戻されてしまう。
    // 値の変わらない更新(ingestError:null)で生存だけを知らせる。
    //
    // 条件に PROCESSING を入れているのは、失敗を書いた直後に飛び立っていた
    // 最後の1発が着弾して ingestError を消してしまうのを防ぐため
    // (画面に「失敗」とだけ出て理由が空になる)。updateMany なら
    // 対象が無くても例外にならない
    const heartbeat = setInterval(() => {
      void this.prisma.manual
        .updateMany({
          where: { id, ingestStatus: IngestStatus.PROCESSING },
          data: { ingestError: null },
        })
        .catch(() => undefined);
    }, INGEST_TOUCH_MS);
    heartbeat.unref?.();
    try {
      const manual = await this.prisma.manual.findUniqueOrThrow({
        where: { id },
      });
      await this.prisma.manual.update({
        where: { id },
        data: { ingestStatus: IngestStatus.PROCESSING, ingestError: null },
      });

      // Pythonが読めるように署名付きURLを発行して渡す(バケットの認証情報は渡さない)。
      // ragコンテナから到達できる内部ネットワーク向けのURLを使う
      const downloadUrl = await this.storage.createInternalDownloadUrl(
        manual.fileKey,
        manual.fileName,
      );
      const { chunkCount, pdfCreatedAt } = await this.rag.ingest(
        manual.id,
        downloadUrl,
        // 形式ごとに読み方が違うので、拡張子が分かるようファイル名も渡す
        manual.fileName,
      );

      // 読み取れた分をまず記録する。ここではまだCOMPLETEDにしない
      await this.prisma.manual.update({
        where: { id },
        data: {
          chunkCount,
          ingestedAt: new Date(),
          // 読み取れたときだけ更新する(既に入っている値を消さない)
          ...(pdfCreatedAt ? { pdfCreatedAt } : {}),
        },
      });

      // 「AIにおまかせ」指定なら、ここでカテゴリを割り当てる。
      //
      // 分類より先にCOMPLETEDにしてはいけない。画面は「取り込みが終わった=
      // 置き場所が決まった」と見なすため、分類が終わる前に完了扱いにすると
      // 「未分類に入りました」と表示した直後にAIが別のフォルダへ移し、
      // 未分類を見ても無い、という食い違いが起きる
      if (autoCategorize) {
        await this.autoCategorizeOne(id);
      }

      // 置き場所まで決まってから完了にする
      await this.prisma.manual.update({
        where: { id },
        data: { ingestStatus: IngestStatus.COMPLETED },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : '不明なエラー';
      this.logger.error(`取り込み失敗 manual=${id}: ${message}`);
      await this.prisma.manual
        .update({
          where: { id },
          data: { ingestStatus: IngestStatus.FAILED, ingestError: message },
        })
        .catch(() => undefined); // マニュアル自体が削除済みの場合は無視
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** 未分類(かつ取り込み済み)のマニュアルをAIでまとめて自動分類する */
  /** 未分類のマニュアルをAIで分類する(必要なら新カテゴリも作る) */
  async autoOrganize() {
    return this.organizeManuals(
      { categoryId: null },
      true,
      undefined,
      'UNCATEGORIZED',
    );
  }

  /**
   * 全マニュアルを工種・業務分野ごとのフォルダへ再分類し直す(チャットの管理操作用)。
   * 必要ならAIが新しいフォルダも作る。既存の分類は上書きされるため、
   * 呼び出し側で必ず確認を挟むこと。instructionは管理者が指定した分類方針
   */
  async reclassifyAll(instruction?: string) {
    return this.organizeManuals({}, true, instruction, 'ALL');
  }

  /**
   * 全件再分類をバックグラウンドで開始する。既に実行中ならfalseを返す
   * (フロントは false を「既に実行中です」の分岐に使うので意味を変えない)。
   *
   * 進行状況はインスタンス内のメモリではなく ReclassifyStore に置く。
   * Cloud Run は開始したのとは別のインスタンスへ進捗を聞きに行くので、
   * メモリだと必ず「動いていません」と答えて表示が壊れる。
   * ただしAWS本番にはまだ表が無いため、既定はメモリのまま
   * (reclassify-store.ts の説明を参照)。
   *
   * onFinish は inline のときだけ呼ぶ。Cloud Tasks 経由では実処理が
   * 別インスタンスで走るため、conversationId をジョブに載せて
   * 実行した側から会話へ書き込む
   */
  async startReclassifyAll(
    instruction?: string,
    onFinish?: (result: ReclassifyOutcome) => void,
    conversationId?: string,
  ): Promise<boolean> {
    // 「実行中か」と「開始を記録」は必ず1文で行う。分けて書くと、
    // そのあいだのDB往復の隙間で両方が「空いている」と読み、
    // 再分類が二重に走って控え(ReclassifySnapshot)も2つできる
    const jobId = await this.reclassifyStore.tryStart(
      instruction,
      conversationId,
    );
    if (jobId === null) return false;
    if (onFinish && this.jobs.mode === 'inline') {
      this.reclassifyCallbacks.set(jobId, onFinish);
    }
    try {
      await this.jobs.dispatchReclassify(jobId);
    } catch (e) {
      // 投げ損ねたことを黙って飲み込むと、画面は「開始しました」と出したまま
      // 永久に終わらない。状態にも残し、呼び出し元にも失敗として伝える
      this.reclassifyCallbacks.delete(jobId);
      const error = e instanceof Error ? e.message : '不明なエラー';
      await this.reclassifyStore
        .finish(jobId, { ...emptyReclassifyOutcome(), ok: false, error })
        .catch(() => undefined);
      throw new ServiceUnavailableException(
        `再分類を開始できませんでした: ${error}`,
      );
    }
    return true;
  }

  /**
   * 全件再分類の実処理。inline では順番待ちを介さずここへ来る。
   *
   * 例外を投げない(結果はジョブの状態に書く)。戻り値は完了通知に使う:
   * チャットから始めた場合、実行した側が会話へ書き込む必要がある
   */
  async runReclassify(jobId: string): Promise<{
    outcome: ReclassifyOutcome;
    conversationId: string | null;
  } | null> {
    const job = await this.reclassifyStore.read(jobId);
    if (!job) {
      this.logger.warn(`再分類ジョブが見つかりません job=${jobId}`);
      return null;
    }
    // 配り直されたタスクで、終わった再分類をもう一度走らせない
    if (!job.running) {
      this.logger.warn(`再分類ジョブは既に終わっています job=${jobId}`);
      return null;
    }

    let outcome: ReclassifyOutcome;
    try {
      const result = await this.reclassifyAll(job.instruction ?? undefined);
      outcome = {
        ok: true,
        movedCount: result.movedCount,
        createdCategories: result.createdCategories,
        emptiedCategories: result.emptiedCategories,
        movedToLocked: result.movedToLocked,
        skippedLocked: result.skippedLocked,
        conflictedCount: result.conflictedCount,
      };
    } catch (e) {
      outcome = {
        ...emptyReclassifyOutcome(),
        ok: false,
        error: e instanceof Error ? e.message : '不明なエラー',
      };
    }
    await this.reclassifyStore.finish(jobId, outcome).catch((e: unknown) => {
      this.logger.error(
        `再分類の結果を保存できませんでした job=${jobId}: ` +
          (e instanceof Error ? e.message : '不明なエラー'),
      );
    });
    const callback = this.reclassifyCallbacks.get(jobId);
    this.reclassifyCallbacks.delete(jobId);
    callback?.(outcome);
    return { outcome, conversationId: job.conversationId };
  }

  /** そのフォルダに入っている(ゴミ箱以外の)マニュアルの数 */
  countInCategory(categoryId: string) {
    return this.prisma.manual.count({
      where: { ...ALIVE, categoryId },
    });
  }

  /** 再分類の対象件数(ピン留めを除く)とピン留め件数 */
  async reclassifyCounts() {
    const [target, pinned, locked] = await Promise.all([
      this.prisma.manual.count({
        where: {
          ...ALIVE,
          ingestStatus: IngestStatus.COMPLETED,
          categoryPinned: false,
          // 実際に動かす件数を返す。鍵付きの中身は対象外なので、
          // ここで数えると確認画面の件数が実際より多くなる
          AND: [
            { OR: [{ categoryId: null }, { category: { adminOnly: false } }] },
          ],
        },
      }),
      this.prisma.manual.count({
        where: {
          ...ALIVE,
          ingestStatus: IngestStatus.COMPLETED,
          categoryPinned: true,
        },
      }),
      this.prisma.manual.count({
        where: {
          ...ALIVE,
          ingestStatus: IngestStatus.COMPLETED,
          categoryPinned: false,
          category: { adminOnly: true },
        },
      }),
    ]);
    return { target, pinned, locked };
  }

  /**
   * 対象マニュアルをAIで分類してDBへ反映する共通処理。
   * 1回のLLM呼び出しに全件を入れると応答JSONが出力上限(4000トークン)で
   * 途中で切れるため、バッチに分けて呼ぶ
   */
  private async organizeManuals(
    where: Prisma.ManualWhereInput,
    allowNew: boolean,
    instruction?: string,
    // 元に戻せるようにするため、どの操作かを記録する
    kind: 'ALL' | 'SELECTED' | 'UNCATEGORIZED' = 'ALL',
  ) {
    const manuals = await this.prisma.manual.findMany({
      // ピン留め(手動分類)されたものはAIの分類で動かさない。
      //
      // 鍵付きフォルダの中身も、どの経路でも動かさない。AIが別の箱へ移すと
      // 隠していた資料が全員に見える場所へ出てしまう。しかもAIが新しく作る
      // フォルダは必ず鍵なしなので、行き先が公開になる確率は低くない。
      // 鍵付きから出したいときは、一覧でドラッグするか、チャットで
      // 「〇〇を△△フォルダに移動して」と1件ずつ指示する(意図が明確な操作に限る)
      where: {
        ...ALIVE,
        ingestStatus: IngestStatus.COMPLETED,
        categoryPinned: false,
        // 呼び出し側の条件もANDの中に入れる。同じ階層に展開すると、
        // キーが衝突したときに黙って片方が消える(それで実際に漏れた)
        AND: [
          where,
          { OR: [{ categoryId: null }, { category: { adminOnly: false } }] },
        ],
      },
      // 表紙が複数チャンクに割れていることがあるので2つ取る
      include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 2 } },
    });

    // 鍵付きフォルダの中にあって、対象から外した分の名前。
    // 「1件も動かさなかった」ときこそ理由が要るので、早期returnより前で数える
    const lockedOut = await this.prisma.manual.findMany({
      where: {
        ...ALIVE,
        ingestStatus: IngestStatus.COMPLETED,
        categoryPinned: false,
        AND: [where, { category: { adminOnly: true } }],
      },
      select: { title: true },
      orderBy: { title: 'asc' },
    });
    const skippedLocked = lockedOut.map((m) => m.title);

    if (manuals.length === 0) {
      return {
        movedCount: 0,
        createdCategories: [],
        emptiedCategories: [],
        moved: [] as {
          manualId: string;
          categoryName: string;
          adminOnly: boolean;
          title: string;
        }[],
        movedToLocked: [] as string[],
        conflictedCount: 0,
        skippedLocked,
      };
    }

    // 1回の呼び出し時間とレスポンスJSONのトークン量の両方に余裕を持たせる。
    // (80件だと応答が出力上限4000トークンに接近し、通信も1分を超えやすい)
    // 管理者が蓄積した分類ルール(「〜は〜のフォルダへ」)を最優先で効かせる
    const rules = await this.classificationRules();

    // 実行前のフォルダごとの件数を控える。分類が終わったあとに取り直して
    // 「前は入っていたのに空になったフォルダ」を割り出す
    const countsBefore = await this.categoryManualCounts();

    const BATCH_SIZE = 50;
    let movedCount = 0;
    const createdCategories: string[] = [];
    const moved: {
      manualId: string;
      categoryName: string;
      adminOnly: boolean;
    }[] = [];
    // ルールが食い違って保留にしたマニュアル(動かしていない)
    const conflictedIds: string[] = [];
    for (let i = 0; i < manuals.length; i += BATCH_SIZE) {
      const batch = manuals.slice(i, i + BATCH_SIZE);
      // カテゴリはバッチごとに取り直す(前のバッチが作った新カテゴリを次も使えるように)。
      // ゴミ箱の中のフォルダは候補に出さない(選ばれても入れられないため)。
      // 鍵付きフォルダは候補に含める。分類を実行できるのは管理者だけで、
      // 鍵付きの中身も管理者には見えているため、行き先から外すと
      // 「あのフォルダに入れて」という指示が黙って無視される
      const categories = await this.prisma.manualCategory.findMany({
        where: ALIVE,
      });
      const assignments = await this.rag.organize(
        batch.map((m) => ({
          manualId: m.id,
          title: m.title,
          snippet: m.chunks
            .map((c) => c.content)
            .join('\n')
            .slice(0, CLASSIFY_SNIPPET_CHARS),
        })),
        categories.map((c) => c.name),
        allowNew,
        instruction,
        rules,
      );
      const result = await this.applyAssignments(assignments, allowNew);
      movedCount += result.movedCount;
      createdCategories.push(...result.createdCategories);
      moved.push(...result.moved);
      conflictedIds.push(...result.conflicted);
    }
    const emptiedCategories = await this.findEmptiedCategories(countsBefore);
    // 題名を添えて返す(呼び出し側はどのファイルがどこへ入ったかを画面に出す)
    const titleById = new Map(manuals.map((m) => [m.id, m.title]));
    const movedWithTitles = moved.map((m) => ({
      ...m,
      title: titleById.get(m.manualId) ?? '',
    }));
    // 動かす前の分類を控える。AIの再分類は一度に何十件も動かすので、
    // 思っていたのと違ったときに手で戻すのは現実的でない。
    // 「その後に人が手で動かしたもの」を巻き込まないよう、動いた先(after)も持つ
    if (movedCount > 0) {
      const categoryBefore = new Map(manuals.map((m) => [m.id, m.categoryId]));
      const categoryIdByName = new Map(
        (
          await this.prisma.manualCategory.findMany({
            where: { name: { in: moved.map((m) => m.categoryName) }, ...ALIVE },
            select: { id: true, name: true },
          })
        ).map((c) => [c.name, c.id]),
      );
      await this.prisma.reclassifySnapshot.create({
        data: {
          kind,
          movedCount,
          createdCategories: createdCategories.length
            ? createdCategories
            : undefined,
          entries: moved.map((m) => ({
            manualId: m.manualId,
            before: categoryBefore.get(m.manualId) ?? null,
            after: categoryIdByName.get(m.categoryName) ?? null,
          })),
        },
      });
    }

    return {
      movedCount,
      createdCategories,
      emptiedCategories,
      moved: movedWithTitles,
      // ルールが食い違って保留にした件数。呼び出し側が「選んでください」と促す
      conflictedCount: conflictedIds.length,
      // 鍵付きフォルダへ入れた分。呼び出し側は必ず利用者に伝える。
      // 黙って入れると、一般利用者から見えなくなったことに誰も気づけない
      movedToLocked: movedWithTitles
        .filter((m) => m.adminOnly)
        .map((m) => m.title),
      // 鍵付きの中にあって動かさなかった分。黙って外すと
      // 「再分類したのに直っていない」ようにしか見えない
      skippedLocked,
    };
  }

  /** 生きているフォルダごとの、生きているマニュアル件数 */
  private async categoryManualCounts(): Promise<Map<string, number>> {
    const rows = await this.prisma.manual.groupBy({
      by: ['categoryId'],
      where: ALIVE,
      _count: { _all: true },
    });
    return new Map(
      rows
        .filter((r) => r.categoryId !== null)
        .map((r) => [r.categoryId as string, r._count._all]),
    );
  }

  /**
   * 分類の前後を比べて「中身があったのに空になったフォルダ」を返す。
   * もともと空だったフォルダは対象にしない(この分類で空になったわけではないため)。
   * 消すかどうかは利用者が決めるので、ここでは候補を挙げるだけ
   */
  private async findEmptiedCategories(countsBefore: Map<string, number>) {
    const countsAfter = await this.categoryManualCounts();
    const emptiedIds = [...countsBefore.entries()]
      .filter(([id, before]) => before > 0 && (countsAfter.get(id) ?? 0) === 0)
      .map(([id]) => id);
    if (emptiedIds.length === 0) return [];
    const categories = await this.prisma.manualCategory.findMany({
      where: { id: { in: emptiedIds }, ...ALIVE },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, createdByAi: true },
    });
    return categories;
  }

  /**
   * 選んだマニュアルだけをAIで分類し直す。
   *
   * 合うフォルダが無ければ新しく作る(allowNew=true)。既存に無理に押し込むと
   * 分類の意味が薄れるため、必要なら箱を増やす方を選ぶ。
   * ピン留めされたものは動かさない(ピン留めは「AIに動かされたくない」という
   * 意思表示なので、まとめて選ばれても尊重する)。黙って残すと直ったように
   * 見えてしまうので、件数を返して画面で伝える。
   */
  async reclassifySelected(ids: string[]) {
    if (ids.length === 0) {
      return {
        conflictedCount: 0,
        movedCount: 0,
        skippedPinned: [],
        skippedNotReady: [],
        skippedLocked: [],
        moved: [] as {
          title: string;
          categoryName: string;
          adminOnly: boolean;
        }[],
        createdCategories: [],
      };
    }
    // 対象になり得るものと、ならないものを先に分ける(理由を伝えるため)
    const targets = await this.prisma.manual.findMany({
      where: { id: { in: ids }, ...ALIVE },
      select: {
        id: true,
        title: true,
        categoryPinned: true,
        ingestStatus: true,
        category: { select: { adminOnly: true } },
      },
    });
    const skippedPinned = targets
      .filter((m) => m.categoryPinned)
      .map((m) => m.title);
    // 取り込みが終わっていないものは中身が読めないので分類できない
    const skippedNotReady = targets
      .filter(
        (m) => !m.categoryPinned && m.ingestStatus !== IngestStatus.COMPLETED,
      )
      .map((m) => m.title);
    // 鍵付きフォルダの中身は動かさない。選んだのに黙って何も起きないと
    // 「効かなかった」ようにしか見えないので、名前を返して画面で伝える
    const skippedLocked = targets
      .filter(
        (m) =>
          !m.categoryPinned &&
          m.ingestStatus === IngestStatus.COMPLETED &&
          m.category?.adminOnly === true,
      )
      .map((m) => m.title);

    const result = await this.organizeManuals(
      { id: { in: ids } },
      true,
      undefined,
      'SELECTED',
    );

    return {
      conflictedCount: result.conflictedCount,
      movedCount: result.movedCount,
      skippedPinned,
      skippedNotReady,
      skippedLocked,
      moved: result.moved.map((m) => ({
        title: m.title,
        categoryName: m.categoryName,
        adminOnly: m.adminOnly,
      })),
      createdCategories: result.createdCategories,
    };
  }

  /**
   * 分類ルールが食い違って保留になっているマニュアル。
   * 行き先は決めていないので、今のフォルダのまま止まっている
   */
  async pendingConflicts() {
    const rows = await this.prisma.classifyConflict.findMany({
      where: { resolvedAt: null, manual: ALIVE },
      include: { manual: { include: { category: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      manualId: r.manualId,
      title: r.manual.title,
      currentCategory: r.manual.category?.name ?? null,
      candidates: (r.candidates as string[]) ?? [],
    }));
  }

  /**
   * 保留になっていたマニュアルの行き先を決める。
   * categoryName が null なら「今のままにする」(動かさずに保留だけ解く)
   */
  async resolveConflict(manualId: string, categoryName: string | null) {
    const conflict = await this.prisma.classifyConflict.findUnique({
      where: { manualId },
    });
    if (!conflict || conflict.resolvedAt) {
      throw new BadRequestException('この保留はもうありません');
    }
    let movedTo: string | null = null;
    if (categoryName) {
      const candidates = (conflict.candidates as string[]) ?? [];
      if (!candidates.includes(categoryName)) {
        // 候補以外へは入れない(画面と食い違う指定を弾く)
        throw new BadRequestException('候補にないフォルダは選べません');
      }
      // ゴミ箱の中のフォルダには入れない(迷子になるため)
      let category = await this.prisma.manualCategory.findFirst({
        where: { name: categoryName, ...ALIVE },
      });
      category ??= await this.prisma.manualCategory.create({
        data: { name: categoryName, createdByAi: true },
      });
      await this.prisma.manual.update({
        where: { id: manualId },
        data: { categoryId: category.id },
      });
      movedTo = category.name;
    }
    await this.prisma.classifyConflict.update({
      where: { manualId },
      data: { resolvedAt: new Date() },
    });
    const remaining = await this.prisma.classifyConflict.count({
      where: { resolvedAt: null, manual: ALIVE },
    });
    return { movedTo, remaining };
  }

  /**
   * 直前の再分類の控え(まだ戻していないもの)。画面に「元に戻す」を出すかの判断に使う
   */
  async lastReclassify() {
    const snap = await this.prisma.reclassifySnapshot.findFirst({
      where: { undoneAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!snap) return null;
    return {
      id: snap.id,
      kind: snap.kind,
      movedCount: snap.movedCount,
      createdCategories: (snap.createdCategories as string[] | null) ?? [],
      createdAt: snap.createdAt,
    };
  }

  /**
   * 直前の再分類を元に戻す。
   *
   * 戻すのは「AIが動かしたあと、人が触っていないマニュアル」だけ。
   * 再分類のあとに手でフォルダを移したものまで戻すと、その作業を
   * 黙って取り消すことになるので、今の分類が動かした先と違うものは飛ばす。
   */
  async undoLastReclassify() {
    const snap = await this.prisma.reclassifySnapshot.findFirst({
      where: { undoneAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!snap) {
      throw new BadRequestException('元に戻せる再分類がありません');
    }
    const entries = snap.entries as {
      manualId: string;
      before: string | null;
      after: string | null;
    }[];

    const current = await this.prisma.manual.findMany({
      where: { id: { in: entries.map((e) => e.manualId) }, ...ALIVE },
      select: { id: true, title: true, categoryId: true },
    });
    const byId = new Map(current.map((m) => [m.id, m]));

    const restored: string[] = [];
    const skipped: string[] = [];
    for (const entry of entries) {
      const manual = byId.get(entry.manualId);
      if (!manual) continue; // 消された分は何もしない
      if (manual.categoryId !== entry.after) {
        // 再分類のあとに人が動かしている。その判断を尊重して触らない
        skipped.push(manual.title);
        continue;
      }
      if (manual.categoryId === entry.before) continue; // すでに元の場所
      await this.prisma.manual.update({
        where: { id: manual.id },
        data: { categoryId: entry.before },
      });
      restored.push(manual.title);
    }

    await this.prisma.reclassifySnapshot.update({
      where: { id: snap.id },
      data: { undoneAt: new Date() },
    });

    return {
      restoredCount: restored.length,
      skippedCount: skipped.length,
      skipped: skipped.slice(0, 10),
      // 戻すと空になるフォルダ。消すかどうかは利用者に決めてもらう
      createdCategories: (snap.createdCategories as string[] | null) ?? [],
    };
  }

  /** 1件だけAIで分類する(アップロード時の「AIにおまかせ」用)。失敗しても取り込みは成功扱い */
  private async autoCategorizeOne(manualId: string) {
    try {
      const manual = await this.prisma.manual.findUnique({
        where: { id: manualId },
        // 表紙が複数チャンクに割れていることがあるので2つ取る
        include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 2 } },
      });
      if (!manual || manual.categoryId) return;
      // アップロード直後の自動分類では、鍵付きフォルダを行き先にしない。
      //
      // 分類が終わるのは(書き起こしを挟むと)取り込みの数分後で、そのとき
      // アップロード画面を閉じていると「鍵付きへ入って一般利用者から
      // 見えなくなった」ことを伝える手段が無い。黙って隠すことになるので、
      // ここでは候補から外す。鍵付きへ入れたいときは、あとから
      // 一覧でドラッグするか、チャットで移動を指示する
      const categories = await this.prisma.manualCategory.findMany({
        where: { ...ALIVE, adminOnly: false },
      });
      const assignments = await this.rag.organize(
        [
          {
            manualId: manual.id,
            title: manual.title,
            snippet: manual.chunks
              .map((c) => c.content)
              .join('\n')
              .slice(0, CLASSIFY_SNIPPET_CHARS),
          },
        ],
        categories.map((c) => c.name),
        true,
        undefined,
        await this.classificationRules(),
      );
      // 候補から外していても、AIが名前を言い当てた場合に備えてここでも止める
      await this.applyAssignments(assignments, true, false);
    } catch (e) {
      // 分類の失敗は致命的ではない(未分類のまま残るだけ)
      const message = e instanceof Error ? e.message : '不明なエラー';
      this.logger.error(`自動分類失敗 manual=${manualId}: ${message}`);
    }
  }

  /** 管理者が蓄積した分類ルールを登録順で返す(分類プロンプトに注入する) */
  private async classificationRules(): Promise<string[]> {
    const rules = await this.prisma.classificationRule.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rules.map((r) => r.text);
  }

  /** AIの割り当て結果をDBに反映する(allowNew=trueならカテゴリが無ければ作る) */
  private async applyAssignments(
    assignments: {
      manualId: string;
      category: string | null;
      candidates?: string[];
    }[],
    allowNew = true,
    allowLockedDestination = true,
  ) {
    const createdCategories: string[] = [];
    // ルールが食い違って保留にしたマニュアル(動かさない)
    const conflicted: string[] = [];
    // どのマニュアルをどのフォルダへ入れたか。選んだファイルだけを
    // 分類したときに、1件ずつ結果を見せられるようにする。
    // 行き先が鍵付きかどうかも返す(黙って隠すことにならないよう画面で伝える)
    const moved: {
      manualId: string;
      categoryName: string;
      adminOnly: boolean;
    }[] = [];
    for (const assignment of assignments) {
      // 管理者のルールが食い違ったものは動かさない。どちらが正しいかは
      // 運用の判断なので、候補だけ残して利用者に選んでもらう。
      // 勝手に動かさないので、選び忘れても実害が出ない
      if (!assignment.category && (assignment.candidates?.length ?? 0) >= 2) {
        await this.prisma.classifyConflict.upsert({
          where: { manualId: assignment.manualId },
          update: { candidates: assignment.candidates!, resolvedAt: null },
          create: {
            manualId: assignment.manualId,
            candidates: assignment.candidates!,
          },
        });
        conflicted.push(assignment.manualId);
        continue;
      }
      const name = (assignment.category ?? '').trim();
      if (!name) continue;
      let category = await this.prisma.manualCategory.findFirst({
        // ゴミ箱の中のフォルダには絶対に入れない。入れてしまうと画面のどこにも
        // 出てこない(サイドバーはゴミ箱のフォルダを出さず、未分類でもなく、
        // マニュアル自体は生きているのでゴミ箱にも出ない)迷子になる
        where: {
          name,
          ...ALIVE,
          ...(allowLockedDestination ? {} : { adminOnly: false }),
        },
      });
      if (!category) {
        // 既存カテゴリ限定モードでは、AIが指示を破って作った未知の名前は無視する
        if (!allowNew) continue;
        // 同名がゴミ箱にあっても作れる(一意なのは生きているフォルダの中だけ)
        category = await this.prisma.manualCategory.create({
          data: { name, createdByAi: true },
        });
        createdCategories.push(name);
      }
      await this.prisma.manual.update({
        where: { id: assignment.manualId },
        data: { categoryId: category.id },
      });
      moved.push({
        manualId: assignment.manualId,
        categoryName: category.name,
        adminOnly: category.adminOnly,
      });
    }
    return {
      movedCount: moved.length,
      createdCategories,
      moved,
      conflicted,
    };
  }

  /**
   * 画面に出る名前を変える。
   *
   * 変えるのは表示名(title)だけで、元のファイル名(fileName)は触らない。
   * fileNameは同名アップロードの新旧判定とダウンロード時のファイル名に
   * 使っているので、ここで書き換えると「同じ資料の更新版を上げたのに
   * 別物として増える」ことになる。
   */
  async rename(id: string, title: string) {
    const trimmed = title.trim().normalize('NFC');
    if (!trimmed) {
      throw new BadRequestException('名前を入力してください');
    }
    const manual = await this.prisma.manual.findFirst({
      where: { id, ...ALIVE },
    });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    if (trimmed === manual.title) return manual; // 変わっていなければ何もしない

    const updated = await this.prisma.manual.update({
      where: { id },
      data: { title: trimmed.slice(0, 200) },
    });

    // ベクトルは取り込み時に「タイトル\n本文」で作っているため、
    // 名前を変えると意味検索だけが古い名前のまま取り残される。
    // 本文は変わっていないので、埋め込みだけを作り直す。
    //
    // 応答を返したあとに走らせてはいけない。Cloud Run はレスポンスを返した
    // 時点でCPUを止めるので、fire-and-forgetだと埋め込みが更新されないまま
    // 凍り付く。数秒で終わる処理なので、待ってから応答を返す。
    // 失敗しても名前の変更自体は成立させる(キーワード・タイトル検索は
    // 検索時にDBを読むので、こちらは即座に反映されている)
    await this.rag.reembedTitle(id).catch((e: unknown) => {
      this.logger.error(
        `名前変更後の検索用データ更新に失敗 manual=${id}: ` +
          (e instanceof Error ? e.message : '不明なエラー'),
      );
    });
    return updated;
  }

  /** マニュアルを別カテゴリへ移動する(categoryId=nullで未分類へ) */
  async move(id: string, categoryId: string | null) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    if (categoryId) {
      // ゴミ箱の中のフォルダへは移せない(移すと画面から見えなくなるため)
      const category = await this.prisma.manualCategory.findFirst({
        where: { id: categoryId, ...ALIVE },
      });
      if (!category) {
        throw new BadRequestException('移動先のカテゴリが見つかりません');
      }
    }
    // ピン留めは移動では変えない(右クリックの「ピン留め」でだけ切り替える)。
    // 移動しただけで再分類の対象から外れると、意図せず固定される
    return this.prisma.manual.update({
      where: { id },
      data: { categoryId },
    });
  }

  /** 複数のマニュアルをまとめて移動する。戻り値は移動した件数 */
  async moveMany(ids: string[], categoryId: string | null) {
    if (ids.length === 0) return 0;
    if (categoryId) {
      const category = await this.prisma.manualCategory.findFirst({
        where: { id: categoryId, ...ALIVE },
      });
      if (!category) {
        throw new BadRequestException('移動先のカテゴリが見つかりません');
      }
    }
    const result = await this.prisma.manual.updateMany({
      where: { id: { in: ids } },
      data: { categoryId }, // ピン留めは変えない(move参照)
    });
    return result.count;
  }

  /**
   * 名前を手がかりに1件だけ移動する(チャットからの「〇〇を△△に入れて」用)。
   * 取り違えて動かさないよう、曖昧なときは移動せず候補を返す
   */
  async moveByName(manualQuery: string, folderQuery: string) {
    const manualNeedle = manualQuery.normalize('NFC').trim();
    const folderNeedle = folderQuery.normalize('NFC').trim();
    if (!manualNeedle || !folderNeedle) {
      return { status: 'invalid' as const };
    }

    const manuals = await this.prisma.manual.findMany({
      where: {
        title: { contains: manualNeedle, mode: 'insensitive' },
        ...ALIVE,
      },
      orderBy: { title: 'asc' },
    });
    // 見つからないときは、空白の入り方の違いを吸収して探し直す。
    // AIは「ベルックス(全角空白区切り)FSタイプ 施工説明書」のように全角空白で
    // 区切った題名を渡してくることがあり、そのままでは当たらない
    if (manuals.length === 0) {
      const all = await this.prisma.manual.findMany({
        where: ALIVE,
        orderBy: { title: 'asc' },
      });
      const { same, similar } = looseMatch(manualNeedle, all);
      if (same.length === 0) {
        // 近いものを候補として返す。まとめての移動はできないので、
        // 呼び出し側で「1件ずつ選んでください」と案内する
        return { status: 'manual_not_found' as const, manuals: similar };
      }
      manuals.push(...same);
    }
    if (manuals.length > 1) {
      // 候補をボタンで選べるようにしてあるので、押されたときは題名がそのまま届く。
      // 完全に一致する1件があればそれで確定する(部分一致のままだと
      // 「ANDPAD導入周知文」が「ANDPAD導入周知文書」も拾って選び直しになる)
      const exact = manuals.filter(
        (m) =>
          m.title.normalize('NFC').toLowerCase() === manualNeedle.toLowerCase(),
      );
      if (exact.length !== 1) {
        return { status: 'manual_ambiguous' as const, manuals };
      }
      manuals.length = 0;
      manuals.push(exact[0]);
    }
    const manual = manuals[0];

    // 「未分類」への指定は分類を外す操作として扱う
    if (/^(未分類|分類なし|なし)$/.test(folderNeedle)) {
      const moved = await this.move(manual.id, null);
      return {
        status: 'moved' as const,
        manual: moved,
        folderName: '未分類',
        folderAdminOnly: false,
      };
    }

    // 鍵付きフォルダも行き先にできる(移動を頼めるのは管理者だけで、
    // 鍵の中身も見えているため)。ゴミ箱の中のフォルダは除く
    const categories = await this.prisma.manualCategory.findMany({
      where: {
        name: { contains: folderNeedle, mode: 'insensitive' },
        ...ALIVE,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    if (categories.length === 0) {
      const all = await this.prisma.manualCategory.findMany({
        where: ALIVE,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return { status: 'folder_not_found' as const, folders: all };
    }
    if (categories.length > 1) {
      return { status: 'folder_ambiguous' as const, folders: categories };
    }

    const moved = await this.move(manual.id, categories[0].id);
    return {
      status: 'moved' as const,
      manual: moved,
      folderName: categories[0].name,
      folderAdminOnly: categories[0].adminOnly,
    };
  }

  /** ピン留めの切り替え(ピン=AIの再分類で動かさない) */
  async setPinned(id: string, pinned: boolean) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    return this.prisma.manual.update({
      where: { id },
      data: { categoryPinned: pinned },
    });
  }

  async getDownloadUrl(id: string, includeAdminOnly = false) {
    const manual = await this.prisma.manual.findFirst({
      // 隠しフォルダの中身は、IDを知っていても開けないようにする。
      // 一覧に出さないだけでは、リンクを共有された時点で読めてしまう
      where: { id, AND: this.visibleTo(includeAdminOnly) },
    });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    const url = await this.storage.createDownloadUrl(
      manual.fileKey,
      manual.fileName,
    );
    return {
      url,
      fileName: manual.fileName,
      // 画面はここを見て、埋め込み表示かダウンロード案内かを決める
      viewableInBrowser:
        fileTypeOf(manual.fileName)?.viewableInBrowser ?? false,
    };
  }

  /**
   * 一括ダウンロード用に、複数マニュアルの署名付きURLをまとめて発行する。
   * ブラウザ側がこのURLからファイルを取得してZIPにまとめる
   */
  async getDownloadTargets(ids: string[], includeAdminOnly = false) {
    if (ids.length === 0) return [];
    const manuals = await this.prisma.manual.findMany({
      where: {
        ...ALIVE,
        id: { in: ids },
        AND: this.visibleTo(includeAdminOnly),
      },
      orderBy: { title: 'asc' },
    });
    return Promise.all(
      manuals.map(async (manual) => ({
        id: manual.id,
        title: manual.title,
        fileName: manual.fileName,
        url: await this.storage.createDownloadUrl(
          manual.fileKey,
          manual.fileName,
        ),
      })),
    );
  }

  /**
   * ゴミ箱へ移す(実体はまだ消さない)。
   * 一覧・検索・AI回答からは外れるが、復元できる
   */
  async delete(id: string) {
    const manual = await this.prisma.manual.findFirst({
      where: { ...ALIVE, id },
    });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    return this.prisma.manual.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** まとめてゴミ箱へ移す。戻り値は移せた件数 */
  async deleteMany(ids: string[]) {
    const { count } = await this.prisma.manual.updateMany({
      where: { ...ALIVE, id: { in: ids } },
      data: { deletedAt: new Date() },
    });
    return count;
  }

  /**
   * ゴミ箱の中身(捨てた順)。
   * フォルダごと捨てたマニュアルはフォルダの中に入ったままなので、
   * ここには出さない(フォルダを戻せば一緒に戻る)
   */
  async trashed() {
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: { not: null } },
      include: { category: true },
      orderBy: { deletedAt: 'desc' },
    });
    return manuals.filter(
      (m) =>
        !(
          m.category?.deletedAt &&
          m.deletedAt &&
          m.category.deletedAt.getTime() === m.deletedAt.getTime()
        ),
    );
  }

  /** ゴミ箱に入っているフォルダ(中の件数付き) */
  async trashedCategories() {
    const categories = await this.prisma.manualCategory.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
    });
    return Promise.all(
      categories.map(async (category) => {
        // 一緒に捨てられた=同じ日時のものだけを数える。
        // フォルダを捨てる前から個別にゴミ箱にあった分は別扱い
        const stats = await this.prisma.manual.aggregate({
          where: { categoryId: category.id, deletedAt: category.deletedAt },
          _count: { _all: true },
          _sum: { size: true },
        });
        return {
          ...category,
          manualCount: stats._count._all,
          totalSize: stats._sum.size ?? 0,
        };
      }),
    );
  }

  /**
   * 空のフォルダだけをゴミ箱へ移す(再分類後の片付け用)。
   *
   * 一覧を出してから押すまでの間に、アップロードや手動の移動で中身が
   * 入ることがある。通常のフォルダ削除は中身ごと捨てる仕様なので、
   * そのまま呼ぶとマニュアルが黙ってゴミ箱に落ちる。ここで必ず数え直し、
   * 空でなくなっていたら見送って名前を返す
   */
  async deleteEmptyCategories(ids: string[]) {
    if (ids.length === 0) return { deletedIds: [], skipped: [] };
    const categories = await this.prisma.manualCategory.findMany({
      where: { id: { in: ids }, ...ALIVE },
      select: { id: true, name: true },
    });
    const deletedAt = new Date();
    const deletedIds: string[] = [];
    const skipped: string[] = [];
    for (const category of categories) {
      // 数えてから消すまでの隙間に中身が入ると、生きているマニュアルが
      // ゴミ箱のフォルダに取り残される(画面のどこにも出てこなくなる)。
      // 「空である」ことを条件に含めた1文で書き換え、判定と更新を分けない
      const updated = await this.prisma.$executeRaw`
        UPDATE "ManualCategory" c
        SET deleted_at = ${deletedAt}
        WHERE c.id = ${category.id}
          AND c.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "Manual" m
            WHERE m."categoryId" = c.id AND m.deleted_at IS NULL
          )
      `;
      if (updated === 1) deletedIds.push(category.id);
      else skipped.push(category.name);
    }
    return { deletedIds, skipped };
  }

  /**
   * 再分類の結果に、今の状態を重ねて返す。
   *
   * 空になったフォルダの一覧は完了時点の写しなので、そのまま出すと
   * 「もう消したフォルダ」「あとから中身が入ったフォルダ」が残ってしまう。
   * 画面に出す直前に、今も生きていて今も空のものだけに絞る
   */
  async reclassifyStatusView(): Promise<ReclassifyStatus> {
    // ここは管理者のサイドバーが30秒ごと(開始直後は3秒ごと)に叩く。
    // 例外を返すとトーストが荒れ続けるので、読めなかったときも値で返す。
    let job: ReclassifyStatus;
    try {
      job = await this.reclassifyStore.latest();
      // 読めた値だけを控える。次に読めなかったときはこれを返す
      this.lastReclassifyStatus = job;
    } catch (e) {
      this.logger.error(
        '再分類の進行状況を読めませんでした: ' +
          (e instanceof Error ? e.message : '不明なエラー'),
      );
      // 「読めなかった」を「何も起きていない」と同じ値で返してはいけない。
      // emptyReclassifyStatus() は running=false / error=null なので、
      // フロントは running が true→false に変わったと読み、
      // 「再分類が完了しました(0件を割り当て)」を出してしまう。
      // 実際にはまだ走っていて、本当に終わったときには何も出ない。
      //
      // 直前に読めた値があればそれを返す(running=true のままなので
      // 画面は進捗表示を続け、DBが戻れば本当の結果を拾える)。
      // 一度も読めていなければ、読めなかったことを error に入れて返す
      return (
        this.lastReclassifyStatus ?? {
          ...emptyReclassifyStatus(),
          error:
            '再分類の進行状況を読み取れませんでした。しばらくしてからもう一度確認してください',
        }
      );
    }
    if (job.emptiedCategories.length === 0) return job;
    const ids = job.emptiedCategories.map((c) => c.id);
    try {
      const [alive, counts] = await Promise.all([
        this.prisma.manualCategory.findMany({
          where: { id: { in: ids }, ...ALIVE },
          // サイドバーと同じ並びで出す(見比べながら選べるように)
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, createdByAi: true },
        }),
        this.prisma.manual.groupBy({
          by: ['categoryId'],
          where: { ...ALIVE, categoryId: { in: ids } },
          _count: { _all: true },
        }),
      ]);
      const hasContents = new Set(
        counts.filter((c) => c._count._all > 0).map((c) => c.categoryId),
      );
      return {
        ...job,
        emptiedCategories: alive.filter((c) => !hasContents.has(c.id)),
      };
    } catch (e) {
      // 絞り込みに失敗しても、進捗そのものは返す(完了通知を落とさない)
      this.logger.error(
        '空になったフォルダの絞り込みに失敗しました: ' +
          (e instanceof Error ? e.message : '不明なエラー'),
      );
      return job;
    }
  }

  /** ゴミ箱のフォルダを中身ごと元に戻す */
  /**
   * 復元するフォルダに付ける、生きている中で重複しない名前を作る。
   *
   * 同名のフォルダがあっても「見せる範囲(鍵)」が違うときは、まとめてしまうと
   * 鍵付きだった中身が全員に見える場所へ出てしまう。名前を変えて別に戻す
   */
  private async uniqueCategoryName(base: string) {
    for (let i = 1; i < 100; i++) {
      const name = i === 1 ? `${base} (復元)` : `${base} (復元${i})`;
      const taken = await this.prisma.manualCategory.findFirst({
        where: { name, ...ALIVE },
        select: { id: true },
      });
      if (!taken) return name;
    }
    // ここまで来ることは実際には無いが、名前を返せないと復元できないため
    return `${base} (復元x)`;
  }

  async restoreCategories(ids: string[]) {
    const categories = await this.prisma.manualCategory.findMany({
      where: { id: { in: ids }, deletedAt: { not: null } },
    });
    // 同名の生きているフォルダがあったため、中身だけをそちらへ戻した分
    const mergedInto: string[] = [];
    // 見せる範囲が違うので、まとめずに別の名前で戻した分
    const restoredSeparately: string[] = [];
    for (const category of categories) {
      // 捨てている間に同じ名前のフォルダが作られていることがある
      // (再分類が作り直すなど)。フォルダ名は生きている中で一意なので
      // そのままでは戻せない。中身だけを既存のフォルダへ入れ、
      // 空になったゴミ箱側のフォルダは片付ける
      const live = await this.prisma.manualCategory.findFirst({
        where: { name: category.name, ...ALIVE },
      });
      // 名前が同じでも鍵の有無が違うなら、まとめてはいけない。
      // 鍵付きだった中身を鍵なしのフォルダへ入れると、戻した瞬間に
      // 一般利用者の一覧・検索・ダウンロード・AIの回答に出てしまう
      if (live && live.adminOnly !== category.adminOnly) {
        const name = await this.uniqueCategoryName(category.name);
        await this.prisma.$transaction([
          this.prisma.manual.updateMany({
            where: { categoryId: category.id, deletedAt: category.deletedAt },
            data: { deletedAt: null },
          }),
          this.prisma.manualCategory.update({
            where: { id: category.id },
            // adminOnlyは元のまま。鍵の状態を変えずに戻すのがこの分岐の目的
            data: { deletedAt: null, name },
          }),
        ]);
        restoredSeparately.push(name);
        continue;
      }
      if (live) {
        await this.prisma.$transaction([
          this.prisma.manual.updateMany({
            where: { categoryId: category.id, deletedAt: category.deletedAt },
            data: { deletedAt: null, categoryId: live.id },
          }),
          // 片方でも利用者が作った箱なら、残る方も手作業扱いにする。
          // そうしないと、手で作った箱を捨てている間にAIが同名の箱を
          // 作り直していた場合、復元をきっかけに印が消えて、
          // 空になったときの片付け候補に自動で入ってしまう
          ...(category.createdByAi || !live.createdByAi
            ? []
            : [
                this.prisma.manualCategory.update({
                  where: { id: live.id },
                  data: { createdByAi: false },
                }),
              ]),
          this.prisma.manualCategory.delete({ where: { id: category.id } }),
        ]);
        mergedInto.push(category.name);
        continue;
      }
      await this.prisma.$transaction([
        // 一緒に捨てたマニュアルだけを戻す
        this.prisma.manual.updateMany({
          where: { categoryId: category.id, deletedAt: category.deletedAt },
          data: { deletedAt: null },
        }),
        this.prisma.manualCategory.update({
          where: { id: category.id },
          data: { deletedAt: null },
        }),
      ]);
    }
    return { restoredCount: categories.length, mergedInto, restoredSeparately };
  }

  /** ゴミ箱のフォルダを中身ごと完全に削除する */
  async purgeCategories(ids: string[]) {
    const categories = await this.prisma.manualCategory.findMany({
      where: { id: { in: ids }, deletedAt: { not: null } },
    });
    let purged = 0;
    for (const category of categories) {
      // 中のマニュアルを先に消さないと外部キーで消せない
      const inside = await this.prisma.manual.findMany({
        where: { categoryId: category.id },
        select: { id: true },
      });
      await this.purgeMany(inside.map((m) => m.id));
      const left = await this.prisma.manual.count({
        where: { categoryId: category.id },
      });
      if (left > 0) {
        this.logger.error(
          `フォルダを削除できません(${left}件残っています) category=${category.id}`,
        );
        continue;
      }
      await this.prisma.manualCategory.delete({ where: { id: category.id } });
      purged++;
    }
    return purged;
  }

  /**
   * ゴミ箱から元に戻す。戻り値は復元できた件数。
   * 元のフォルダ自体がゴミ箱にある場合は、戻しても見えなくなってしまうので
   * 未分類へ移す
   */
  async restoreMany(ids: string[]) {
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: { not: null }, id: { in: ids } },
      include: { category: true },
    });
    for (const manual of manuals) {
      const category = manual.category;
      // 入っていたフォルダもゴミ箱にある場合は、通常は未分類へ戻す。
      // ただし鍵付きフォルダだったものを未分類へ出すと、そこは誰にでも
      // 見える場所なので、隠していた資料がそのまま全員に見えてしまう。
      // その場合はフォルダごと復活させ、元の鍵付きの場所へ戻す
      if (category?.deletedAt && category.adminOnly) {
        const conflict = await this.prisma.manualCategory.findFirst({
          where: { name: category.name, ...ALIVE },
          select: { id: true },
        });
        await this.prisma.manualCategory.update({
          where: { id: category.id },
          data: {
            deletedAt: null,
            // 捨てている間に同じ名前のフォルダが作られていたら名前を変える
            ...(conflict
              ? { name: await this.uniqueCategoryName(category.name) }
              : {}),
          },
        });
        await this.prisma.manual.update({
          where: { id: manual.id },
          data: { deletedAt: null, categoryId: category.id },
        });
        continue;
      }
      await this.prisma.manual.update({
        where: { id: manual.id },
        data: {
          deletedAt: null,
          categoryId: category?.deletedAt ? null : manual.categoryId,
        },
      });
    }
    return manuals.length;
  }

  /**
   * ゴミ箱から完全に削除する(実ファイルごと)。戻り値は削除できた件数。
   * 生きているマニュアルは対象にしない(誤って消さないため)
   */
  async purgeMany(ids: string[]) {
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: { not: null }, id: { in: ids } },
    });
    let purged = 0;
    for (const manual of manuals) {
      try {
        // 先にストレージの実ファイルを消し、成功したらDBの行を消す。
        // 逆順だと、ストレージ削除失敗時に「DBに無いのにファイルだけ残る」迷子ができる
        await this.storage.deleteObject(manual.fileKey);
        await this.prisma.manual.delete({ where: { id: manual.id } });
        purged++;
      } catch (e) {
        const message = e instanceof Error ? e.message : '不明なエラー';
        this.logger.error(`完全削除に失敗 manual=${manual.id}: ${message}`);
      }
    }
    return purged;
  }

  /** ゴミ箱を空にする(フォルダも含めて完全削除) */
  async emptyTrash() {
    const categories = await this.prisma.manualCategory.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true },
    });
    const purgedCategories = await this.purgeCategories(
      categories.map((c) => c.id),
    );
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true },
    });
    const purgedManuals = await this.purgeMany(manuals.map((m) => m.id));
    return purgedManuals + purgedCategories;
  }

  /**
   * 捨ててから一定期間が過ぎたものを自動で完全削除する。
   * 起動時と1日ごとに実行する(専用のスケジューラを増やさない)
   */
  private async purgeExpiredTrash() {
    const limit = new Date(
      Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    // フォルダを先に消す(中のマニュアルごと消える)
    const expiredCategories = await this.prisma.manualCategory.findMany({
      where: { deletedAt: { lt: limit } },
      select: { id: true },
    });
    const purgedCategories = await this.purgeCategories(
      expiredCategories.map((c) => c.id),
    );
    const expired = await this.prisma.manual.findMany({
      where: { deletedAt: { lt: limit } },
      select: { id: true },
    });
    if (expired.length === 0 && purgedCategories === 0) return;
    const purged =
      (await this.purgeMany(expired.map((m) => m.id))) + purgedCategories;
    this.logger.log(
      `ゴミ箱の自動削除: ${purged}件(${TRASH_RETENTION_DAYS}日経過)`,
    );
  }
}
