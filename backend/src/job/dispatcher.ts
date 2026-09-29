import { Injectable, Logger } from '@nestjs/common';

/**
 * 応答を返したあとに走らせたい処理の投げ先。
 *
 * Cloud Run はリクエストの応答を返した時点でCPUを止める(既定の
 * request-based billing)。`void 何か()` で始めた取り込みや再分類は、
 * その場で凍り付いて二度と進まない。--no-cpu-throttling を付けても
 * min-instances=0 では保証されないと公式に明記されている。
 *
 * そこで「裏で走らせる」を1か所に集めて、環境変数で投げ先を選べるようにした。
 *
 * - inline      … 今までどおり同じプロセスで実行する(AWS/ローカルの既定)
 * - cloud_tasks … Google Cloud Tasks に積み、内部エンドポイントを叩かせる
 * - self_http   … 自分のURLを自分でHTTPで叩く(Cloud Tasksが使えないときの逃げ道)
 *
 * 切り替え日までAWSが本番なので、既定は必ず inline にする。
 */
export type DispatchMode = 'inline' | 'cloud_tasks' | 'self_http';

const MODES: DispatchMode[] = ['inline', 'cloud_tasks', 'self_http'];

/**
 * 実処理の本体。ManualService が起動時に差し込む。
 *
 * DIで JobDispatcher → ManualService と依存させると、ManualService が
 * JobDispatcher を使っているので循環する。呼ばれる側から登録してもらう
 */
export interface JobHandlers {
  ingest: (manualId: string, autoCategorize: boolean) => void;
  reclassify: (jobId: string) => Promise<unknown>;
}

/** Cloud Tasks に渡す本文。内部エンドポイントが受け取る形と同じ */
export interface IngestJobPayload {
  manualId: string;
  autoCategorize: boolean;
  /** 積んだ時刻。再配送されたときに「もう終わっている仕事か」を見分ける */
  dispatchedAt: string;
}

export interface ReclassifyJobPayload {
  jobId: string;
  dispatchedAt: string;
}

/**
 * Cloud Tasks の dispatchDeadline。実測で 15秒〜30分の範囲しか受け付けず、
 * 2000s を送ると 400 INVALID_ARGUMENT になる(未指定の既定は600s=10分)。
 *
 * 取り込みは RagService 側が15分でタイムアウトし、503/502/504 のときだけ
 * 90秒待ってもう一度15分試すので、最悪およそ31分かかる。30分を超えると
 * Cloud Tasks は失敗とみなすため、上限いっぱいの1800sにしたうえで
 * キューを --max-attempts=1 で作る(再配送させない)。
 * 超えた分は FAILED として残り、管理者が「再取り込み」でやり直せる。
 * 黙って同じPDFを二重に取り込むより、失敗として見えるほうがよい。
 */
const DEFAULT_DISPATCH_DEADLINE = '1800s';

/** self_http でこちら側が応答を待つ時間。相手の処理は待たない */
const SELF_HTTP_WAIT_MS = 3_000;

/** メタデータサーバから取ったトークンを、期限のどれだけ手前で捨てるか */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** 環境変数から投げ先を決める。知らない値は inline に倒す(黙って止めない) */
export function resolveDispatchMode(
  raw = process.env.INGEST_DISPATCH,
): DispatchMode {
  const value = (raw ?? '').trim() as DispatchMode;
  return MODES.includes(value) ? value : 'inline';
}

/** 差し替えできるようにした fetch。標準の Response がそのまま当てはまる形 */
interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponseLike>;

@Injectable()
export class JobDispatcher {
  private readonly logger = new Logger(JobDispatcher.name);

  /**
   * テストと非常時の差し替え口。素の fetch を使うのは意図的で、
   * @google-cloud/tasks は展開11.9MB + grpc依存でイメージが太る。
   * Artifact Registry の無料枠は0.5GBしかないので、REST を直接叩く
   */
  fetchImpl: FetchLike = (input, init) => fetch(input, init);

  /** アクセストークンの取得。Cloud Run のメタデータサーバから取る */
  fetchAccessToken: () => Promise<{ token: string; expiresInSec: number }> =
    () => this.fetchAccessTokenFromMetadata();

  /** self_http の待ち時間。テストから短くできるようにフィールドで持つ */
  selfHttpWaitMs = SELF_HTTP_WAIT_MS;

  private handlers: JobHandlers | null = null;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  get mode(): DispatchMode {
    return resolveDispatchMode();
  }

  /** 実処理を差し込む(ManualService の onApplicationBootstrap から呼ぶ) */
  register(handlers: JobHandlers) {
    this.handlers = handlers;
  }

  /**
   * 起動時の設定チェック。
   *
   * Cloud Run は自分のサービスURLを環境変数で教えてくれない
   * (入るのは PORT / K_SERVICE / K_REVISION / K_CONFIGURATION だけ)。
   * INTERNAL_BASE_URL を入れ忘れたまま cloud_tasks/self_http にすると、
   * 取り込みが全部行方不明になる。黙って壊れるより起動を止める。
   */
  verifyConfig() {
    const mode = this.mode;
    const raw = (process.env.INGEST_DISPATCH ?? '').trim();
    // 綴り違い(cloudtasks / cloud-tasks など)は resolveDispatchMode が
    // inline に倒すので、そのままだと「設定したのに効いていない」ことに
    // 誰も気づけない。未設定は AWS/ローカルの正常な経路なので通し、
    // 「書いてあるのに読めない値」だけをここで弾く
    if (raw !== '' && !MODES.includes(raw as DispatchMode)) {
      throw new Error(
        `INGEST_DISPATCH=${raw} は不明な値です。` +
          `${MODES.join(' / ')} のいずれかにしてください`,
      );
    }
    if (mode === 'inline') {
      // Cloud Run は応答を返した時点でCPUを止めるので、inline で始めた
      // 取り込みと再分類はその場で凍り、二度と進まない(画面は
      // 「取り込み中」のまま)。K_SERVICE は Cloud Run が必ず渡してくる
      // 環境変数なので、INGEST_DISPATCH の入れ忘れをここで捕まえる。
      // 承知のうえで同一プロセスに寄せたい場合(--no-cpu-throttling を
      // 付けて試すなど)は inline と明示すれば通す
      if (process.env.K_SERVICE) {
        if (raw !== 'inline') {
          throw new Error(
            'Cloud Run 上で動いていますが INGEST_DISPATCH が設定されていません。' +
              'このまま起動すると、取り込みと再分類が応答を返した時点で止まります。' +
              'INGEST_DISPATCH=cloud_tasks(推奨)または self_http を設定してください' +
              '(同一プロセスで走らせると分かったうえでなら inline と明示してください)',
          );
        }
        this.logger.warn(
          'Cloud Run で INGEST_DISPATCH=inline が明示されています。' +
            '--no-cpu-throttling が無いと取り込みは応答後に止まります',
        );
      }
      return;
    }
    const missing: string[] = [];
    if (!process.env.INTERNAL_BASE_URL) missing.push('INTERNAL_BASE_URL');
    if (!process.env.INGEST_INTERNAL_TOKEN)
      missing.push('INGEST_INTERNAL_TOKEN');
    if (mode === 'cloud_tasks') {
      if (!process.env.GCP_PROJECT_ID) missing.push('GCP_PROJECT_ID');
      if (!this.tasksLocation()) missing.push('GCP_TASKS_LOCATION(GCP_REGION)');
      if (!process.env.GCP_TASKS_QUEUE) missing.push('GCP_TASKS_QUEUE');
    }
    if (missing.length > 0) {
      throw new Error(
        `INGEST_DISPATCH=${mode} には ${missing.join(' / ')} が必要です`,
      );
    }
  }

  /**
   * cloud_tasks のときだけ、起動直後に一度トークンを取ってみる。
   *
   * Cloud Run のメタデータサーバから Cloud Tasks 用のトークンが取れるかは
   * デプロイしないと確かめられない(手元に metadata.google.internal が無い)。
   * ここで失敗を「起動時のログ」として出しておけば、最初のアップロードまで
   * 気づかない事態を避けられる。ただし起動自体は止めない:
   * 検索や閲覧は動くので、取り込みだけのために全機能を落とす理由が無い。
   * 取り込みの失敗は register/startIngest 側で FAILED として画面に出る。
   */
  async warmUpCredentials() {
    if (this.mode !== 'cloud_tasks') return;
    try {
      await this.accessToken();
      this.logger.log('Cloud Tasks 用のアクセストークンを取得できました');
    } catch (e) {
      this.logger.error(
        'Cloud Tasks 用のアクセストークンを取得できませんでした。' +
          '取り込みは失敗します(INGEST_DISPATCH=self_http へ逃がせます): ' +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  /** 取り込みを裏へ投げる。inline のときは既存の順番待ちに入るだけ */
  async dispatchIngest(manualId: string, autoCategorize: boolean) {
    const payload: IngestJobPayload = {
      manualId,
      autoCategorize,
      dispatchedAt: new Date().toISOString(),
    };
    switch (this.mode) {
      case 'inline':
        this.requireHandlers().ingest(manualId, autoCategorize);
        return;
      case 'cloud_tasks':
        await this.enqueueCloudTask(
          process.env.GCP_TASKS_QUEUE ?? '',
          '/internal/ingest',
          payload,
        );
        return;
      case 'self_http':
        await this.postToSelf('/internal/ingest', payload);
        return;
    }
  }

  /** 全件再分類を裏へ投げる */
  async dispatchReclassify(jobId: string) {
    const payload: ReclassifyJobPayload = {
      jobId,
      dispatchedAt: new Date().toISOString(),
    };
    switch (this.mode) {
      case 'inline':
        // inline は「待たずに走らせる」が仕様。失敗はジョブの状態に書かれる
        void this.requireHandlers()
          .reclassify(jobId)
          .catch(() => undefined);
        return;
      case 'cloud_tasks':
        await this.enqueueCloudTask(
          // 再分類は取り込みと別のキューに積める。取り込みキューは
          // 同時実行1で数十分詰まるので、同じ列に入れると再分類が
          // いつまでも始まらない。指定が無ければ同じキューを使う
          process.env.GCP_TASKS_RECLASSIFY_QUEUE ??
            process.env.GCP_TASKS_QUEUE ??
            '',
          '/internal/reclassify',
          payload,
        );
        return;
      case 'self_http':
        await this.postToSelf('/internal/reclassify', payload);
        return;
    }
  }

  private requireHandlers(): JobHandlers {
    if (!this.handlers) {
      throw new Error('JobDispatcher に実処理が登録されていません');
    }
    return this.handlers;
  }

  private tasksLocation() {
    return process.env.GCP_TASKS_LOCATION ?? process.env.GCP_REGION ?? '';
  }

  private internalUrl(path: string) {
    const base = (process.env.INTERNAL_BASE_URL ?? '').replace(/\/+$/, '');
    return `${base}${path}`;
  }

  /**
   * Cloud Tasks REST v2 にタスクを積む。
   *
   * タスク名(name)は付けない。名前を付けると同じ名前で2回作れず409になり、
   * しかも完了後しばらくは「a task with this name existed recently」で
   * 404になる。`ingest-<manualId>` のような名前にすると、同じマニュアルの
   * 「再取り込み」が短時間のあいだ黙って無視される(実機で両方観測した)。
   * 二重取り込みの防止は、こちら側の取り込み中フラグ(claimIngest)と
   * キューの --max-attempts=1 で担保する。
   *
   * キューは事前に作っておくこと(実装時点でプロジェクトにキューは0件):
   *   gcloud tasks queues create manualy-ingest --location=us-west1 \
   *     --max-concurrent-dispatches=1 --max-attempts=1 --min-backoff=10s
   *   gcloud tasks queues create manualy-reclassify --location=us-west1 \
   *     --max-concurrent-dispatches=1 --max-attempts=1 --min-backoff=10s
   *   gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
   *     --member="serviceAccount:<Cloud Runのサービスアカウント>" \
   *     --role=roles/cloudtasks.enqueuer
   * --min-backoff を省くと既定が0.100sになり、--max-attempts を増やしたとき
   * 1秒未満で全部焼き切れてタスクが消える(実機で観測)。
   */
  private async enqueueCloudTask(
    queue: string,
    path: string,
    payload: unknown,
  ) {
    const project = process.env.GCP_PROJECT_ID ?? '';
    const location = this.tasksLocation();
    if (!project || !location || !queue) {
      throw new Error(
        'Cloud Tasks の宛先(GCP_PROJECT_ID / GCP_TASKS_LOCATION / GCP_TASKS_QUEUE)が足りません',
      );
    }
    const token = await this.accessToken();
    const url =
      `https://cloudtasks.googleapis.com/v2/projects/${project}` +
      `/locations/${location}/queues/${queue}/tasks`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        task: {
          httpRequest: {
            httpMethod: 'POST',
            url: this.internalUrl(path),
            headers: {
              'Content-Type': 'application/json',
              // 改変されずに配送側へ届くことは実機で確認済み
              'X-Internal-Token': process.env.INGEST_INTERNAL_TOKEN ?? '',
            },
            body: Buffer.from(JSON.stringify(payload), 'utf8').toString(
              'base64',
            ),
          },
          dispatchDeadline:
            process.env.CLOUD_TASKS_DISPATCH_DEADLINE ??
            DEFAULT_DISPATCH_DEADLINE,
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // 403 は Cloud Run のサービスアカウントに cloudtasks.enqueuer が
      // 付いていないときに出る。ログだけで原因が分かるようにしておく
      const hint =
        res.status === 403
          ? '(サービスアカウントに roles/cloudtasks.enqueuer が要ります)'
          : '';
      throw new Error(
        `Cloud Tasks への登録に失敗しました HTTP ${res.status}${hint} ${detail}`.trim(),
      );
    }
  }

  /**
   * 自分自身の内部エンドポイントをHTTPで叩く(非常用)。
   *
   * 応答は待たない。待つと呼び出し元(アップロードのGraphQL)が
   * 取り込みの数十分に付き合わされる。ただし「送りっぱなしでawaitしない」
   * だけだと、応答後にCPUが止まる環境では接続が張られる前に捨てられうる。
   * 数秒だけ待って、そこから先は放置する。
   *
   * AbortSignal.timeout は使わない。あれは待つのをやめるだけでなく
   * ソケットごと切るので、受け側が処理を続けている最中に接続を壊す。
   * ここで止めたいのは「こちらが待つこと」だけなので、時間で競走させる。
   *
   * この経路は Cloud Tasks が使えないときの逃げ道で、
   * --no-cpu-throttling(かつ受け側が生きていること)が前提。
   */
  private async postToSelf(path: string, payload: unknown) {
    const url = this.internalUrl(path);
    // 失敗は例外ではなく値で返す。競走(race)の相手と型を揃えておかないと、
    // 「時間切れ」と「相手が返したエラー」を取り違える
    const sent: Promise<Error | null> = this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.INGEST_INTERNAL_TOKEN ?? '',
      },
      body: JSON.stringify(payload),
    }).then(
      (res) =>
        res.ok ? null : new Error(`内部エンドポイントが HTTP ${res.status}`),
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    );
    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      sent,
      new Promise<typeof timedOut>((resolve) => {
        const timer = setTimeout(() => resolve(timedOut), this.selfHttpWaitMs);
        timer.unref?.();
      }),
    ]);
    // 待っている間に返ってきた失敗だけを呼び出し元に伝える。
    // 待ち時間を過ぎたものは「まだ処理中」なので成功として扱う
    if (result !== timedOut && result !== null) throw result;
  }

  /** 期限の少し手前まで使い回す(毎回取りに行くとメタデータサーバを叩きすぎる) */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return this.cachedToken.token;
    }
    const { token, expiresInSec } = await this.fetchAccessToken();
    this.cachedToken = {
      token,
      expiresAt: now + expiresInSec * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    };
    return token;
  }

  private async fetchAccessTokenFromMetadata() {
    const res = await this.fetchImpl(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!res.ok) {
      throw new Error(`メタデータサーバが HTTP ${res.status} を返しました`);
    }
    const body = JSON.parse(await res.text()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new Error('メタデータサーバの応答に access_token がありません');
    }
    return {
      token: body.access_token,
      expiresInSec: body.expires_in ?? 3600,
    };
  }
}
