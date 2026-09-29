import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { Roles, UserRole } from '../auth/roles';
import { UserService } from '../user/service';
import { ManualCategory } from './model';
import { CategoryService } from './service';

@Resolver(() => ManualCategory)
export class CategoryResolver {
  constructor(
    private readonly categoryService: CategoryService,
    private readonly userService: UserService,
  ) {}

  // カテゴリ一覧（サイドバー表示用）。
  // 管理者だけに見せるフォルダは、管理者以外には返さない
  @Query(() => [ManualCategory])
  async manualCategories(@CurrentUser() authUser: AuthUser) {
    const user = await this.userService.ensure(authUser);
    return this.categoryService.findAll(user.role === UserRole.ADMIN);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ManualCategory)
  createManualCategory(
    @Args('name') name: string,
    // 管理者だけに見せるフォルダにするか
    @Args('adminOnly', { type: () => Boolean, nullable: true })
    adminOnly?: boolean,
  ) {
    return this.categoryService.create(name, adminOnly ?? false);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ManualCategory)
  updateManualCategory(
    @Args('id', { type: () => ID }) id: string,
    @Args('name') name: string,
    @Args('adminOnly', { type: () => Boolean, nullable: true })
    adminOnly?: boolean,
  ) {
    return this.categoryService.rename(id, name, adminOnly ?? undefined);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ManualCategory)
  deleteManualCategory(@Args('id', { type: () => ID }) id: string) {
    return this.categoryService.delete(id);
  }

  // フォルダの並び替え(ドラッグ)。渡された順に並び順を振り直す
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  reorderManualCategories(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.categoryService.reorder(ids);
  }
}
