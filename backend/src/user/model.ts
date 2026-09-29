import {
  Field,
  GraphQLISODateTime,
  ID,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { UserRole } from '../../generated/prisma/client';

registerEnumType(UserRole, {
  name: 'UserRole',
  description: 'ADMIN=マニュアル管理可 / MEMBER=閲覧・検索のみ',
});

// フロントに返す「今ログインしている自分」の情報
@ObjectType()
export class UserProfile {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => UserRole)
  role!: UserRole;
}

// 管理画面(ユーザー管理)に出す1ユーザー。
// アカウントの実体は認証基盤(Cognito / Supabase Auth)、権限はDBが持つので
// 両者を合成して返す
@ObjectType()
export class ManagedUser {
  @Field(() => ID)
  cognitoSub!: string;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => UserRole)
  role!: UserRole;

  /**
   * 招待直後で仮パスワードのまま(=まだ一度もログインしていない)。
   *
   * これを知っているのは認証側だけ。**updateUserRole の応答では null** を返す。
   * 権限を1件変えるためだけに利用者一覧を引き直すのをやめたので、あそこでは
   * 分からない値になった。分からないものをfalseと言うと「招待中の印」が
   * 消えたように見えるので、分からないままnullで返す。
   * 信用できるのは一覧(users)と招待(inviteUsers)の応答だけ
   */
  @Field(() => Boolean, { nullable: true })
  passwordPending!: boolean | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  createdAt!: Date | null;

  /**
   * 発行したばかりの仮パスワード。追加した直後の応答にだけ入り、一覧では常にnull。
   *
   * メールで送らずに画面へ出すのは、Supabaseの組み込みメールの送信制限が
   * 厳しく、切り替え当日にまとめて招待すると途中で止まるため。管理者が
   * ここに出た文字列をTeamsのDMで本人に配る運用にした。
   * サーバーのログには絶対に出さない(Loggerを通さない)
   */
  @Field(() => String, { nullable: true })
  temporaryPassword?: string | null;
}

/** まとめて招待したときに、送れなかった宛先とその理由 */
@ObjectType()
export class InviteFailure {
  @Field()
  email!: string;

  @Field()
  reason!: string;
}

/**
 * まとめて招待した結果。
 * 1件の失敗で全体を止めないので、送れた分と送れなかった分の両方を返す
 */
@ObjectType()
export class InviteResult {
  @Field(() => [ManagedUser])
  invited!: ManagedUser[];

  @Field(() => [InviteFailure])
  failed!: InviteFailure[];
}
