import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { Roles, UserRole } from '../auth/roles';
import { InviteResult, ManagedUser, UserProfile } from './model';
import { UserService } from './service';

@Resolver(() => UserProfile)
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  // 自分自身の情報(フロントが権限に応じてUIを出し分けるのに使う)
  @Query(() => UserProfile)
  me(@CurrentUser() authUser: AuthUser) {
    return this.userService.ensure(authUser);
  }

  // ---- ここから管理者向けのユーザー管理 ----

  @Query(() => [ManagedUser])
  @Roles(UserRole.ADMIN)
  users() {
    return this.userService.listManaged();
  }

  /**
   * メールアドレスで招待する(複数可)。仮パスワードはCognitoが本人へメールで送る。
   *
   * まとめて受け取るのは、1件ずつ招待すると届く時刻が人によってばらけるため。
   * 1件の失敗で全体を止めず、送れなかった宛先は理由と一緒に返す
   */
  @Mutation(() => InviteResult)
  @Roles(UserRole.ADMIN)
  inviteUsers(
    @Args('emails', { type: () => [String] }) emails: string[],
    @Args('role', { type: () => UserRole, nullable: true })
    role?: UserRole,
  ) {
    return this.userService.inviteMany(emails, role ?? UserRole.MEMBER);
  }

  @Mutation(() => ManagedUser)
  @Roles(UserRole.ADMIN)
  updateUserRole(
    @Args('cognitoSub', { type: () => ID }) cognitoSub: string,
    @Args('role', { type: () => UserRole }) role: UserRole,
    @CurrentUser() authUser: AuthUser,
  ) {
    return this.userService.updateRole(cognitoSub, role, authUser);
  }

  @Mutation(() => Boolean)
  @Roles(UserRole.ADMIN)
  deleteUser(
    @Args('cognitoSub', { type: () => ID }) cognitoSub: string,
    @CurrentUser() authUser: AuthUser,
  ) {
    return this.userService.remove(cognitoSub, authUser);
  }
}
