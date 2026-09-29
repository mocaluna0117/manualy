import { BadRequestException } from '@nestjs/common';
import { UserService } from './service';

/**
 * まとめて招待する処理。
 *
 * 1件ずつ招待すると届く時刻がばらけるので、まとめて送る。
 * ここで大事なのは「1件の失敗で全体を止めない」こと。既に登録済みの人が
 * 1人混ざっただけで残り全員に届かない、という事故を防ぐ。
 */
describe('UserService.inviteMany', () => {
  /** Cognitoにも DBにも触らない、招待だけを差し替えた薄い実体を作る */
  const build = (
    behavior: (email: string) => void = () => undefined,
  ): { service: UserService; calls: string[] } => {
    const calls: string[] = [];
    const service = Object.create(UserService.prototype) as UserService;
    // 本物のinviteはCognito作成+DB登録。ここでは呼ばれた宛先だけを記録する
    (
      service as unknown as { invite: (e: string, r: unknown) => unknown }
    ).invite = (email: string) => {
      calls.push(email);
      behavior(email); // 特定の宛先だけ失敗させたいときに使う
      return Promise.resolve({
        cognitoSub: `sub-${email}`,
        email,
        role: 'MEMBER',
        passwordPending: true,
        createdAt: null,
      });
    };
    return { service, calls };
  };

  const run = (emails: string[], behavior?: (email: string) => void) => {
    const { service, calls } = build(behavior);
    return service
      .inviteMany(emails, 'MEMBER')
      .then((result) => ({ ...result, calls }));
  };

  it('複数の宛先をまとめて招待する', async () => {
    const r = await run(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(r.invited.map((u) => u.email)).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
    expect(r.failed).toEqual([]);
  });

  it('前後の空白は落とす', async () => {
    const r = await run(['  a@example.com  ']);
    expect(r.calls).toEqual(['a@example.com']);
  });

  it('空の行は無視する', async () => {
    const r = await run(['a@example.com', '', '   ', 'b@example.com']);
    expect(r.calls).toEqual(['a@example.com', 'b@example.com']);
  });

  it('同じ宛先は1回だけ招待する(大文字小文字の違いも同じ扱い)', async () => {
    const r = await run([
      'a@example.com',
      'A@Example.com',
      'a@example.com',
      'b@example.com',
    ]);
    // 2通届いてしまうと受け取った側が混乱するので、1件にまとめる
    expect(r.calls).toEqual(['a@example.com', 'b@example.com']);
  });

  it('1件失敗しても残りは送る', async () => {
    const r = await run(
      ['ok1@example.com', 'dup@example.com', 'ok2@example.com'],
      (email) => {
        if (email === 'dup@example.com') {
          throw new Error('このメールアドレスは既に登録されています');
        }
      },
    );
    expect(r.invited.map((u) => u.email)).toEqual([
      'ok1@example.com',
      'ok2@example.com',
    ]);
    expect(r.failed).toEqual([
      {
        email: 'dup@example.com',
        reason: 'このメールアドレスは既に登録されています',
      },
    ]);
  });

  it('結果は入力した順に並べる(並行実行で順番が崩れないように)', async () => {
    const r = await run(['z@example.com', 'y@example.com', 'x@example.com']);
    expect(r.invited.map((u) => u.email)).toEqual([
      'z@example.com',
      'y@example.com',
      'x@example.com',
    ]);
  });

  it('宛先が1件も無ければ断る', async () => {
    await expect(run(['', '  '])).rejects.toThrow(BadRequestException);
  });

  it('多すぎる場合は断る(押し間違いで大量に送る事故を防ぐ)', async () => {
    const many = Array.from({ length: 31 }, (_, i) => `u${i}@example.com`);
    await expect(run(many)).rejects.toThrow(/30件まで/);
  });

  it('上限ぴったりは通る', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `u${i}@example.com`);
    const r = await run(many);
    expect(r.invited).toHaveLength(30);
  });
});
