/**
 * 問い合わせの添付画像をいつまで残すか。
 *
 * 画像はS3(移行後はR2)に置いてあり、DBには置き場所の文字列しか入らない。
 * DBは増えないが、S3は放っておくと増え続けるので期限を切る。
 *
 * 本文・送信者・日時は消さない。記録としての価値は文章にあり、
 * 容量もほとんど食わないため。
 */

/** 対応済みにしてからこの日数が経ったら画像を消す */
export const KEEP_DAYS_AFTER_HANDLED = 90;

/**
 * 未対応のままでもこの日数が経ったら画像を消す。
 * 対応済みを押し忘れた分が永久に残るのを防ぐための上限
 */
export const KEEP_DAYS_UNHANDLED = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 保存期間を過ぎているか(判定だけを切り出してテストできるようにする) */
export function isImageExpired(
  row: { handledAt: Date | null; createdAt: Date },
  now: number,
): boolean {
  if (row.handledAt) {
    return now - row.handledAt.getTime() > KEEP_DAYS_AFTER_HANDLED * DAY_MS;
  }
  return now - row.createdAt.getTime() > KEEP_DAYS_UNHANDLED * DAY_MS;
}

/**
 * 画像を消す対象を選ぶ。
 *
 * 「まだ画像を持っている」かつ「期限切れ」の行だけを返す。
 * 空配列は「画像はあったが期限切れで消した」印なので、対象にしない
 * (何度も消しに行かないため)
 */
export function selectExpired<
  T extends { imageKeys: unknown; handledAt: Date | null; createdAt: Date },
>(rows: T[], now: number): T[] {
  return rows.filter(
    (r) =>
      Array.isArray(r.imageKeys) &&
      r.imageKeys.length > 0 &&
      isImageExpired(r, now),
  );
}

/**
 * 画像が「期限切れで消された」状態かどうか。
 *
 * 空配列を印として使う(列を増やさずに、最初から添付が無かった場合と
 * 区別するため)。nullは「添付が無かった」または「画像を保存していなかった頃」
 */
export function isPurged(imageKeys: unknown): boolean {
  return Array.isArray(imageKeys) && imageKeys.length === 0;
}
