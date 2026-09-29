import {
  BadRequestException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/service';
import { StorageService } from '../storage/service';
import { buildRawEmail, canReplyTo } from './mail';
import {
  KEEP_DAYS_AFTER_HANDLED,
  KEEP_DAYS_UNHANDLED,
  isPurged,
  selectExpired,
} from './retention';

/** 問い合わせの宛先(カンマ区切りで複数可)。運用で変える場合は環境変数で上書きする */
const TO_EMAILS = (
  process.env.INQUIRY_TO_EMAIL ??
  'admin@example.com'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// SESは差出人も認証済みアドレスである必要があるため、既定は先頭の宛先にする
const FROM_EMAIL = process.env.INQUIRY_FROM_EMAIL ?? TO_EMAILS[0];
const MAX_LENGTH = 2000;

/** 画像1枚の上限(バイト) */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 添付できる枚数 */
const MAX_IMAGE_COUNT = 5;

/**
 * 添付の合計サイズの上限。
 * メールはbase64で約1.33倍に膨らむため、受信箱側の上限(25MB前後が多い)に
 * 引っかからないよう、手前で止める
 */
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/** 添付を受け付ける画像形式(拡張子はここから決める) */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 画像1件分。フロントからはbase64で受け取る */
export interface InquiryImage {
  base64: string;
  format: string;
}

@Injectable()
export class InquiryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InquiryService.name);
  private readonly ses = new SESv2Client({
    region: process.env.AWS_REGION ?? 'ap-northeast-1',
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * 起動のたびに、保存期間を過ぎた添付画像を片付ける。
   * マニュアルのゴミ箱掃除(ManualService)と同じ考え方。
   * 失敗しても起動は止めない(次の起動でまた試す)
   */
  onApplicationBootstrap() {
    void this.purgeExpiredImages().catch((e: unknown) => {
      this.logger.error(
        `添付画像の片付けに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  /**
   * 保存期間を過ぎた添付画像をS3から消し、DBの記録を空配列にする。
   *
   * 空配列は「画像はあったが期限切れで消した」印。nullのまま残すと
   * 「最初から添付が無かった」場合と区別できず、画面で説明できない
   */
  async purgeExpiredImages(now = Date.now()) {
    const candidates = await this.prisma.inquiry.findMany({
      // 期限の候補を日付で絞る。実際に画像を持っているかは後で見る
      // (JSON列のnull判定はPrismaで紛らわしいため、件数も少ないのでJS側で判定する)
      where: {
        OR: [
          {
            handledAt: {
              lt: new Date(now - KEEP_DAYS_AFTER_HANDLED * 24 * 60 * 60 * 1000),
            },
          },
          {
            handledAt: null,
            createdAt: {
              lt: new Date(now - KEEP_DAYS_UNHANDLED * 24 * 60 * 60 * 1000),
            },
          },
        ],
      },
      select: { id: true, imageKeys: true, handledAt: true, createdAt: true },
    });

    const targets = selectExpired(candidates, now);
    if (targets.length === 0) return 0;

    let purged = 0;
    for (const row of targets) {
      const keys = row.imageKeys as string[];
      // S3から消せなかった分はDBの記録も残す(次の起動でもう一度試すため)
      const failed = await this.deleteObjects(keys);
      if (failed.length > 0) {
        this.logger.warn(
          `問い合わせ ${row.id} の画像${failed.length}件を消せませんでした`,
        );
        continue;
      }
      await this.prisma.inquiry.update({
        where: { id: row.id },
        data: { imageKeys: [] },
      });
      purged += keys.length;
    }
    if (purged > 0) {
      this.logger.log(
        `保存期間を過ぎた問い合わせの添付画像${purged}件を削除しました`,
      );
    }
    return purged;
  }

  /** まとめて消して、消せなかったキーを返す */
  private async deleteObjects(keys: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (const key of keys) {
      try {
        await this.storage.deleteObject(key);
      } catch {
        failed.push(key);
      }
    }
    return failed;
  }

  /**
   * 問い合わせを受け付ける。
   * まずDBに残してからメールを送る。メール送信に失敗しても内容は失われず、
   * 利用者には「受け付けた」と返す(送れなかったことはログに残す)
   */
  async send(
    message: string,
    userEmail: string | null,
    images: InquiryImage[] = [],
  ) {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new BadRequestException('内容を入力してください');
    }
    if (trimmed.length > MAX_LENGTH) {
      throw new BadRequestException(`内容が長すぎます(${MAX_LENGTH}文字まで)`);
    }

    // 画像はメールに添付し、あわせてS3にも置く。
    // メールだけに載せていたころは、迷惑メールに入ったり見落としたりすると
    // 「うまくいかない画面」の写真ごと辿れなくなっていた
    if (images.length > MAX_IMAGE_COUNT) {
      throw new BadRequestException(
        `画像は${MAX_IMAGE_COUNT}枚までにしてください`,
      );
    }
    const attachments = images.map((image, i) => {
      const ext = image.format.toLowerCase();
      const mimeType = IMAGE_TYPES[ext];
      if (!mimeType) {
        throw new BadRequestException(`対応していない画像形式です: ${ext}`);
      }
      const bytes = Buffer.from(image.base64, 'base64');
      if (bytes.length === 0) {
        throw new BadRequestException('画像を読み取れませんでした');
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new BadRequestException('画像は1枚あたり4MB以下にしてください');
      }
      // 受信側で並び順が分かるよう、名前に番号を振る
      return { bytes, mimeType, filename: `screenshot-${i + 1}.${ext}` };
    });
    const totalBytes = attachments.reduce((sum, a) => sum + a.bytes.length, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new BadRequestException('画像の合計が大きすぎます(全部で10MBまで)');
    }

    const imageKeys = await this.storeImages(attachments);
    const inquiry = await this.prisma.inquiry.create({
      data: {
        message: trimmed,
        userEmail,
        imageKeys: imageKeys.length > 0 ? imageKeys : undefined,
      },
    });

    const subject = `【Manualy】お問い合わせ (${userEmail ?? '不明'})`;
    const body = [
      `送信者: ${userEmail ?? '不明'}`,
      // サーバーの時計はUTCなので、時間帯を明示しないとイギリス標準時で出る
      `受付日時: ${inquiry.createdAt.toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
      })}`,
      '',
      trimmed,
    ].join('\n');

    // SESのサンドボックスでは未認証の宛先が1人でも混ざると送信全体が拒否される。
    // 1通ずつ送ることで、届けられる宛先には確実に届ける
    for (const to of TO_EMAILS) {
      try {
        await this.ses.send(
          new SendEmailCommand({
            FromEmailAddress: FROM_EMAIL,
            Destination: { ToAddresses: [to] },
            // 送信者へそのまま返信できるようにする(同じ社内ドメイン宛ては除く)
            ReplyToAddresses: canReplyTo(to, userEmail)
              ? [userEmail as string]
              : undefined,
            // 添付があるときは、こちらで組み立てたメール全体を渡す。
            // Simple形式は添付を扱えないため
            Content: attachments.length
              ? {
                  Raw: {
                    Data: buildRawEmail({
                      from: FROM_EMAIL,
                      to,
                      replyTo: canReplyTo(to, userEmail) ? userEmail : null,
                      subject,
                      body,
                      attachments,
                    }),
                  },
                }
              : {
                  Simple: {
                    Subject: { Data: subject, Charset: 'UTF-8' },
                    Body: { Text: { Data: body, Charset: 'UTF-8' } },
                  },
                },
          }),
        );
      } catch (e) {
        // 送れない宛先があっても問い合わせ自体は受理済み(DBに残っている)
        this.logger.error(
          `問い合わせメールの送信に失敗 id=${inquiry.id} to=${to}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return true;
  }

  /**
   * 添付画像をS3へ置き、キーを返す。
   * 1枚失敗しても問い合わせ自体は受け付ける(本文の方が大事)
   */
  private async storeImages(
    attachments: { bytes: Buffer; mimeType: string; filename: string }[],
  ): Promise<string[]> {
    const keys: string[] = [];
    for (const a of attachments) {
      try {
        const ext = a.filename.split('.').pop() ?? 'png';
        const key = `inquiry/${randomUUID()}.${ext}`;
        await this.storage.putBytes(key, a.bytes, a.mimeType);
        keys.push(key);
      } catch (e) {
        this.logger.warn(
          `問い合わせの添付画像を保存できませんでした: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return keys;
  }

  /**
   * 問い合わせの一覧(新しい順)。画像は期限付きのURLにして返す。
   * daysを渡すとその日数分だけに絞る(省略・0なら全件)
   */
  async list(days?: number | null) {
    const since =
      days && days > 0
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        : undefined;
    const rows = await this.prisma.inquiry.findMany({
      where: since ? { createdAt: { gte: since } } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        userEmail: r.userEmail,
        message: r.message,
        handledAt: r.handledAt,
        createdAt: r.createdAt,
        imageUrls: await this.imageUrls(r.imageKeys),
        imagesPurged: isPurged(r.imageKeys),
      })),
    );
  }

  /** S3のキーから閲覧用URLを作る。作れなかった分は落とす */
  private async imageUrls(imageKeys: unknown): Promise<string[]> {
    const keys = Array.isArray(imageKeys) ? (imageKeys as string[]) : [];
    if (keys.length === 0) return [];
    const urls = await Promise.all(
      keys.map((key) =>
        this.storage
          // 拡張子から形式を復元する(保存時に付けてある)
          .createImageUrl(key, `image/${key.split('.').pop() ?? 'png'}`)
          .catch(() => null),
      ),
    );
    return urls.filter((u): u is string => u !== null);
  }

  /** 未対応の件数(サイドバーのバッジ用) */
  async counts() {
    const [unhandled, total] = await Promise.all([
      this.prisma.inquiry.count({ where: { handledAt: null } }),
      this.prisma.inquiry.count(),
    ]);
    return { unhandled, total };
  }

  /** 対応済み・未対応を切り替える */
  async setHandled(id: string, handled: boolean) {
    const updated = await this.prisma.inquiry.update({
      where: { id },
      data: { handledAt: handled ? new Date() : null },
    });
    return {
      id: updated.id,
      userEmail: updated.userEmail,
      message: updated.message,
      handledAt: updated.handledAt,
      createdAt: updated.createdAt,
      imageUrls: await this.imageUrls(updated.imageKeys),
      imagesPurged: isPurged(updated.imageKeys),
    };
  }
}

/**
 * 添付つきのメールを組み立てる(MIMEのmultipart)。
 *
 * SESのSimple形式は添付を扱えないので、メール全体を自前で作ってRawで渡す。
 * 日本語の件名と本文は、そのまま書くと文字化けするのでbase64で包む
 */
