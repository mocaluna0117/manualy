import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/public';
import { ChatService } from '../chat/service';
import { ManualService } from '../manual/service';

/**
 * Cloud Tasks(または自分自身)から叩かれる、裏処理の入口。
 *
 * なぜここ(job/)にファイルを置いて ChatModule に登録するのか:
 * - 取り込みは ManualService、再分類の完了通知は ChatService が要る。
 * - ChatModule は既に ManualModule を import しているので、
 *   ChatModule の controllers に置けば両方へ手が届く。
 * - 逆に ManualModule 側へ置くと ManualModule → ChatModule の依存が生まれ、
 *   既にある ChatModule → ManualModule と循環する。
 * - app.module.ts は他の作業と衝突しやすい共有ファイルなので触らずに済ませる。
 *
 * 守り方は RAG サービス(rag/security.py)と同じ考え方にした。
 * @Public() を付けないと APP_GUARD の認証がRESTにも効いて401になるので、
 * 認証は外したうえで共有トークンを自分で照合する。トークン未設定なら全拒否
 * (fail closed。設定を忘れたら誰でも叩ける状態を作らない)。
 */
@Controller('internal')
export class InternalJobController {
  private readonly logger = new Logger(InternalJobController.name);

  constructor(
    private readonly manualService: ManualService,
    private readonly chatService: ChatService,
  ) {}

  /**
   * PDFの取り込み。数十秒〜数分かかる。
   *
   * **業務上の失敗でも必ず2xxを返す。** runIngest は「例外を投げず、成否を
   * DBの ingestStatus に書く」約束なので、ここで非2xxを返すと Cloud Tasks が
   * 数十分かかる取り込みをまるごと積み直し、同じPDFを二重に取り込む。
   * 401(トークン不一致)だけが例外で、これは積み直す価値がある。
   */
  @Public()
  @Post('ingest')
  @HttpCode(200)
  async ingest(
    @Headers('x-internal-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    this.requireInternalToken(token);
    const payload = body as {
      manualId?: unknown;
      autoCategorize?: unknown;
      dispatchedAt?: unknown;
    } | null;
    const manualId =
      typeof payload?.manualId === 'string' ? payload.manualId : '';
    if (!manualId) {
      // 形が壊れたタスクは何度配り直しても成功しない。200で捨てる
      this.logger.error('取り込みの依頼に manualId がありません');
      return { status: 'bad_request' };
    }
    const dispatchedAt = parseDate(payload?.dispatchedAt);
    try {
      const status = await this.manualService.runIngestFromJob(
        manualId,
        payload?.autoCategorize === true,
        dispatchedAt,
      );
      return { status };
    } catch (e) {
      // runIngest は投げない約束だが、その前後(DB断など)で落ちることはある。
      // それでも2xxで返す。積み直されると二重取り込みになるほうが痛い
      this.logger.error(
        `取り込みの実行に失敗 manual=${manualId}: ` +
          (e instanceof Error ? e.message : '不明なエラー'),
      );
      return { status: 'error' };
    }
  }

  /**
   * 全マニュアルの再分類。数分かかる。
   *
   * チャットから始めた場合は、実行したこちら側が会話へ完了を書き込む。
   * 開始したインスタンスのメモリにコールバックを置いても、別のインスタンスで
   * 実行される Cloud Tasks 経由では呼びようがないため
   */
  @Public()
  @Post('reclassify')
  @HttpCode(200)
  async reclassify(
    @Headers('x-internal-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    this.requireInternalToken(token);
    const payload = body as { jobId?: unknown } | null;
    const jobId = typeof payload?.jobId === 'string' ? payload.jobId : '';
    if (!jobId) {
      this.logger.error('再分類の依頼に jobId がありません');
      return { status: 'bad_request' };
    }
    try {
      const done = await this.manualService.runReclassify(jobId);
      if (!done) return { status: 'skipped' };
      if (done.conversationId) {
        await this.chatService.notifyReclassifyFinished(
          done.conversationId,
          done.outcome,
        );
      }
      return { status: 'done' };
    } catch (e) {
      this.logger.error(
        `再分類の実行に失敗 job=${jobId}: ` +
          (e instanceof Error ? e.message : '不明なエラー'),
      );
      return { status: 'error' };
    }
  }

  /**
   * 共有トークンの照合。
   *
   * 長さの違いで例外にならないよう、いったん同じ長さのハッシュにしてから
   * 定数時間で比べる(timingSafeEqual は長さが違うと投げる)。
   * 未設定なら誰も通さない
   */
  private requireInternalToken(token: string | undefined) {
    const expected = process.env.INGEST_INTERNAL_TOKEN;
    if (!expected) {
      this.logger.error(
        'INGEST_INTERNAL_TOKENが設定されていないため、内部エンドポイントへの' +
          'リクエストを拒否しました',
      );
      throw new UnauthorizedException('認証が必要です');
    }
    const digest = (value: string) =>
      createHash('sha256').update(value, 'utf8').digest();
    if (!token || !timingSafeEqual(digest(token), digest(expected))) {
      throw new UnauthorizedException('認証が必要です');
    }
  }
}

/** ISO文字列を日付にする。読めなければ undefined(判定を諦めて実行する) */
function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
