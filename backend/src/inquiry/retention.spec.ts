import {
  KEEP_DAYS_AFTER_HANDLED,
  KEEP_DAYS_UNHANDLED,
  isImageExpired,
  isPurged,
  selectExpired,
} from './retention';

/**
 * 添付画像の保存期間の判定。
 *
 * ここを間違えると、消してはいけない画像を消す(取り返せない)か、
 * 消えずに容量が増え続けるかのどちらかになる。
 * 特に「まだ画像を持っている行だけを対象にする」を固定しておく
 * (空配列を何度も消しに行かないため)。
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-21T00:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY);

describe('isImageExpired', () => {
  it('対応済みから90日を過ぎたら期限切れ', () => {
    const row = { handledAt: ago(91), createdAt: ago(200) };
    expect(isImageExpired(row, NOW)).toBe(true);
  });

  it('対応済みから90日以内なら残す', () => {
    expect(
      isImageExpired({ handledAt: ago(90), createdAt: ago(200) }, NOW),
    ).toBe(false);
    expect(isImageExpired({ handledAt: ago(1), createdAt: ago(1) }, NOW)).toBe(
      false,
    );
  });

  it('未対応でも1年を過ぎたら期限切れ(押し忘れが永久に残らないように)', () => {
    expect(isImageExpired({ handledAt: null, createdAt: ago(366) }, NOW)).toBe(
      true,
    );
    expect(isImageExpired({ handledAt: null, createdAt: ago(365) }, NOW)).toBe(
      false,
    );
  });

  it('古い問い合わせでも、対応済みが最近なら残す(基準は対応日)', () => {
    // 2年前の問い合わせを今日対応済みにした場合
    const row = { handledAt: ago(0), createdAt: ago(730) };
    expect(isImageExpired(row, NOW)).toBe(false);
  });

  it('日数の取り決めが変わっていないこと', () => {
    expect(KEEP_DAYS_AFTER_HANDLED).toBe(90);
    expect(KEEP_DAYS_UNHANDLED).toBe(365);
  });
});

describe('selectExpired', () => {
  const expired = { handledAt: ago(100), createdAt: ago(120) };
  const fresh = { handledAt: ago(1), createdAt: ago(2) };

  it('画像を持っていて期限切れの行だけを選ぶ', () => {
    const rows = [
      { id: 'a', imageKeys: ['inquiry/a.png'], ...expired },
      { id: 'b', imageKeys: ['inquiry/b.png'], ...fresh },
    ];
    expect(selectExpired(rows, NOW).map((r) => r.id)).toEqual(['a']);
  });

  it('添付が無い行(null)は対象にしない', () => {
    const rows = [{ id: 'a', imageKeys: null, ...expired }];
    expect(selectExpired(rows, NOW)).toEqual([]);
  });

  it('すでに消した行(空配列)は対象にしない(何度も消しに行かない)', () => {
    const rows = [{ id: 'a', imageKeys: [], ...expired }];
    expect(selectExpired(rows, NOW)).toEqual([]);
  });

  it('JSONが配列でないときも落ちない', () => {
    const rows = [{ id: 'a', imageKeys: 'こわれた値', ...expired }];
    expect(selectExpired(rows, NOW)).toEqual([]);
  });
});

describe('isPurged', () => {
  it('空配列は「期限切れで消した」印', () => {
    expect(isPurged([])).toBe(true);
  });

  it('nullは「添付が無かった」または「保存していなかった頃」', () => {
    expect(isPurged(null)).toBe(false);
  });

  it('画像が残っているうちはfalse', () => {
    expect(isPurged(['inquiry/a.png'])).toBe(false);
  });
});
