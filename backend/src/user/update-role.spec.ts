import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../auth/current-user';
import { UserService } from './service';

/**
 * 権限の変更。
 *
 * ここは「DBに書いてから認証側の一覧を引き直して、その中から自分を探す」
 * 作りだった。認証側が200で形の違う応答を返すと一覧が0人になり、
 * 権限は変わっているのに『ユーザーが見つかりません』で終わって、
 * その人が画面から消えたように見えた。書けた事実と書けた内容だけを返す。
 */
describe('UserService.updateRole', () => {
  const actor: AuthUser = { userId: 'sub-admin', email: 'admin@example.com' };

  /** DBと認証側を差し替えた薄い実体。認証側は呼ばれたら記録する */
  const build = () => {
    const listUsersCalls: number[] = [];
    const upserts: unknown[] = [];
    const service = Object.create(UserService.prototype) as UserService;
    Object.assign(service, {
      prisma: {
        user: {
          upsert: (args: {
            where: { cognitoSub: string };
            update: unknown;
          }) => {
            upserts.push(args);
            return Promise.resolve({
              id: 'db-1',
              cognitoSub: args.where.cognitoSub,
              email: 'sato@example.com',
              role: (args.update as { role: string }).role,
              createdAt: new Date('2026-09-01T00:00:00Z'),
            });
          },
        },
      },
      admin: {
        listUsers: () => {
          listUsersCalls.push(1);
          // 実機で起きた壊れ方(200だが利用者が読めない)を再現する
          return Promise.reject(new Error('想定外の応答'));
        },
      },
    });
    return { service, listUsersCalls, upserts };
  };

  it('書き込んだ行をそのまま返し、認証側の一覧は引かない', async () => {
    const { service, listUsersCalls } = build();
    const updated = await service.updateRole('sub-sato', 'ADMIN', actor);
    expect(updated).toEqual({
      cognitoSub: 'sub-sato',
      email: 'sato@example.com',
      role: 'ADMIN',
      // 認証側を引かないので「まだログインしていないか」は分からない
      passwordPending: null,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      temporaryPassword: null,
    });
    // 一覧が引けるかどうかに権限変更の成否をぶら下げない
    expect(listUsersCalls).toEqual([]);
  });

  it('認証側の利用者一覧が壊れていても権限変更は成功する', async () => {
    // 以前はここで「ユーザーが見つかりません」になり、権限だけ変わって
    // 画面からその人が消えていた
    const { service } = build();
    await expect(
      service.updateRole('sub-sato', 'ADMIN', actor),
    ).resolves.toMatchObject({ cognitoSub: 'sub-sato', role: 'ADMIN' });
  });

  it('招待直後(未ログイン)の人でも passwordPending を断定しない', async () => {
    // false を返していた頃は、認証側を一度も見ていないのに
    // 「もうログイン済みです」と答えていた。GraphQLの口としては誤り
    const { service } = build();
    const updated = await service.updateRole('sub-invited', 'ADMIN', actor);
    expect(updated.passwordPending).toBeNull();
    expect(updated.passwordPending).not.toBe(false);
  });

  it('自分自身の権限は変えられない(管理者が誰もいなくなる事故を防ぐ)', async () => {
    const { service, upserts } = build();
    await expect(
      service.updateRole('sub-admin', 'MEMBER', actor),
    ).rejects.toThrow(BadRequestException);
    // 断るときはDBにも触らない
    expect(upserts).toEqual([]);
  });
});
