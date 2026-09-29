import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { Roles, UserRole } from '../auth/roles';
import { InquiryImageInput } from './input';
import { InquiryCounts, InquiryItem } from './model';
import { InquiryService } from './service';

@Resolver()
export class InquiryResolver {
  constructor(private readonly inquiryService: InquiryService) {}

  // 問い合わせの送信は全員が使える(管理者への連絡手段)
  @Mutation(() => Boolean)
  sendInquiry(
    @Args('message') message: string,
    @CurrentUser() authUser: AuthUser,
    // 画面のスクリーンショットを添えられるようにする(任意・複数可)
    @Args('images', { type: () => [InquiryImageInput], nullable: true })
    images?: InquiryImageInput[],
  ) {
    return this.inquiryService.send(
      message,
      authUser.email ?? null,
      images ?? [],
    );
  }

  // 以下は管理者だけ。メールを見落としても画面から追えるようにするため
  @Roles(UserRole.ADMIN)
  @Query(() => [InquiryItem])
  inquiries(@Args('days', { type: () => Int, nullable: true }) days?: number) {
    return this.inquiryService.list(days);
  }

  @Roles(UserRole.ADMIN)
  @Query(() => InquiryCounts)
  inquiryCounts() {
    return this.inquiryService.counts();
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => InquiryItem)
  setInquiryHandled(
    @Args('id', { type: () => ID }) id: string,
    @Args('handled') handled: boolean,
  ) {
    return this.inquiryService.setHandled(id, handled);
  }
}
