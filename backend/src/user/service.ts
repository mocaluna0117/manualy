import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { UserRole } from '../../generated/prisma/client';
import { AuthUser } from '../auth/current-user';
import { PrismaService } from '../prisma/service';
import type { UserAdminService } from './admin';
import { USER_ADMIN } from './admin';
import { ManagedUser } from './model';

/**
 * 一度に招待できる件数の上限。
 * 部署単位の追加を想定した数で、押し間違いで大量に送ってしまう事故も防ぐ
 */
const MAX_INVITE_AT_ONCE = 30;

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    // アカウントの実体はCognitoかSupabase Auth。どちらかはAUTH_PROVIDERで
    // 決まる(module.ts)。ここからは同じ口として扱う
    @Inject(USER_ADMIN) private readonly admin: UserAdminService,
  ) {}

  /**
   * JWTで認証されたユーザーをDBに確保する(JITプロビジョニング)。
   * 初回アクセスなら作成、既存ならメールアドレスを最新化。
   * 認証側でユーザーを追加するだけで、アプリ側の登録作業は不要になる。
   *
   * 照合に使うcognitoSubは認証側の不変ID(Supabaseでは利用者のUUID)。
   * 認証基盤を替えると同じ人でも別のIDになるので、切り替えのときは
   * scripts/migrate-user-ids.tsで既存の行を新しいIDへ付け替える。
   * これを忘れると、ここが「初めて来た人」として別の行を作ってしまい、
   * 管理者がMEMBERに落ち、会話履歴が消えたように見える
   */
  ensure(authUser: AuthUser) {
    return this.prisma.user.upsert({
      where: { cognitoSub: authUser.userId },
      update: { email: authUser.email },
      create: { cognitoSub: authUser.userId, email: authUser.email },
    });
  }

  /** 全ユーザーの一覧(アカウント=認証基盤、権限=DBを合成) */
  async listManaged(): Promise<ManagedUser[]> {
    const [authUsers, dbUsers] = await Promise.all([
      this.admin.listUsers(),
      this.prisma.user.findMany({ select: { cognitoSub: true, role: true } }),
    ]);
    const roleBySub = new Map(dbUsers.map((u) => [u.cognitoSub, u.role]));
    return authUsers.map((c) => ({
      cognitoSub: c.sub,
      email: c.email,
      // まだ一度もログインしていない(DB行が無い)ユーザーは既定のMEMBER扱い
      role: roleBySub.get(c.sub) ?? UserRole.MEMBER,
      passwordPending: c.passwordPending,
      createdAt: c.createdAt,
      // 仮パスワードは発行したその場でしか分からない。一覧では出せない
      temporaryPassword: null,
    }));
  }

  /** ユーザーを招待する(認証側にアカウント作成+権限をDBへ事前登録) */
  async invite(email: string, role: UserRole): Promise<ManagedUser> {
    const created = await this.admin.createUser(email);
    // ログイン前でも権限が決まっているように、DB行を先に作っておく。
    // JITプロビジョニングはcognitoSubで照合するので、この行がそのまま使われる
    await this.prisma.user.upsert({
      where: { cognitoSub: created.sub },
      update: { role },
      create: { cognitoSub: created.sub, email, role },
    });
    return {
      cognitoSub: created.sub,
      email: created.email,
      role,
      passwordPending: created.passwordPending,
      createdAt: created.createdAt,
      // Supabase版はここに仮パスワードが入る(Cognito版は招待メールなのでnull)
      temporaryPassword: created.temporaryPassword ?? null,
    };
  }

  /**
   * 複数のメールアドレスをまとめて招待する。
   *
   * 1件ずつ招待すると、届く時刻が人によってばらける。同じ説明を別々の
   * タイミングで受け取ると「自分だけ何か違うのか」と迷わせるので、
   * まとめて実行して同じ時刻に届くようにする。
   *
   * 1件の失敗(既に登録済み・形式不正)で全体を止めない。
   * 送れたものは送り、送れなかったものは理由を返して画面に出す
   */
  async inviteMany(
    emails: string[],
    role: UserRole,
  ): Promise<{
    invited: ManagedUser[];
    failed: { email: string; reason: string }[];
  }> {
    // 前後の空白を落とし、大文字小文字の違いは同じ宛先として1件にまとめる
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const raw of emails) {
      const email = raw.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(email);
    }
    if (targets.length === 0) {
      throw new BadRequestException('招待するメールアドレスを入力してください');
    }
    if (targets.length > MAX_INVITE_AT_ONCE) {
      throw new BadRequestException(
        `一度に招待できるのは${MAX_INVITE_AT_ONCE}件までです`,
      );
    }

    const invited: ManagedUser[] = [];
    const failed: { email: string; reason: string }[] = [];
    // 並行して呼ぶ(順番に待つと最後の人へ届くのが遅れる)
    await Promise.all(
      targets.map(async (email) => {
        try {
          invited.push(await this.invite(email, role));
        } catch (e) {
          failed.push({
            email,
            reason: e instanceof Error ? e.message : '不明なエラー',
          });
        }
      }),
    );
    // 画面に出す順番を入力順に戻す(並行実行で崩れるため)
    const order = new Map(targets.map((e, i) => [e.toLowerCase(), i]));
    const at = (e: string | null) => order.get((e ?? '').toLowerCase()) ?? 999;
    invited.sort((a, b) => at(a.email) - at(b.email));
    failed.sort((a, b) => at(a.email) - at(b.email));
    return { invited, failed };
  }

  /** 権限の変更。自分自身は変更不可(管理者が誰もいなくなる事故を防ぐ) */
  async updateRole(
    cognitoSub: string,
    role: UserRole,
    actor: AuthUser,
  ): Promise<ManagedUser> {
    if (cognitoSub === actor.userId) {
      throw new BadRequestException('自分自身の権限は変更できません');
    }
    // 書き込んだ行をそのまま返す。
    //
    // 以前はここから listManaged() を呼び直していたが、権限はDBに書けている
    // のに一覧の取得だけが外れると「ユーザーが見つかりません」で終わり、
    // その人が画面から消えたように見えた(認証側が200で空の一覧を返したとき
    // に実際に起きる)。書けたという事実と、書けた内容だけを返す
    const updated = await this.prisma.user.upsert({
      where: { cognitoSub },
      update: { role },
      create: { cognitoSub, role },
    });
    return {
      cognitoSub: updated.cognitoSub,
      email: updated.email,
      role: updated.role,
      // 「まだ一度もログインしていない」は認証側しか知らない。権限を1件
      // 変えるためだけに利用者一覧を引き直すのをやめたので、ここでは
      // 分からない。falseと言うと、招待直後(未ログイン)の人まで
      // 「ログイン済み」だと答えることになるので、分からないままnullを返す。
      // 画面がこのミューテーションから受け取るのは cognitoSub と role だけで、
      // 招待中の表示は一覧の再取得で揃う
      // (frontend/src/graphql/users.ts の UPDATE_USER_ROLE_MUTATION)
      passwordPending: null,
      // 認証側のアカウント作成日時ではなくDB行の作成日時。招待で作った人は
      // 招待した時刻に行ができるので、実用上はほぼ同じ値になる
      createdAt: updated.createdAt,
      // 仮パスワードは作成時にしか存在しない
      temporaryPassword: null,
    };
  }

  /**
   * ユーザーの削除。自分自身は削除不可。
   * DB行を消すと会話履歴もカスケード削除される(退職者の後始末を想定)
   */
  async remove(cognitoSub: string, actor: AuthUser): Promise<boolean> {
    if (cognitoSub === actor.userId) {
      throw new BadRequestException('自分自身は削除できません');
    }
    // 認証側の削除に失敗したらDB行は消さない(片方だけ消えた状態を作らない)。
    // 切り替え直後は「DBには居るが認証側には居ない」人がいて、ここが
    // NotFoundになる。先に移行スクリプトで全員を作ってから運用に入る
    await this.admin.deleteUser(cognitoSub);
    await this.prisma.user
      .delete({ where: { cognitoSub } })
      .catch(() => undefined); // 一度もログインしていない人はDB行が無い
    return true;
  }
}
