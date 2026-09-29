import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Roles, UserRole } from '../auth/roles';
import { ClassificationRule } from './model';
import { RuleService } from './service';

// 分類は管理者の領分なので、閲覧も含めてADMIN限定にする
@Resolver(() => ClassificationRule)
export class RuleResolver {
  constructor(private readonly ruleService: RuleService) {}

  @Roles(UserRole.ADMIN)
  @Query(() => [ClassificationRule])
  classificationRules() {
    return this.ruleService.findAll();
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ClassificationRule)
  createClassificationRule(@Args('text') text: string) {
    return this.ruleService.create(text);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ClassificationRule)
  updateClassificationRule(
    @Args('id', { type: () => ID }) id: string,
    @Args('text') text: string,
  ) {
    return this.ruleService.update(id, text);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ClassificationRule)
  deleteClassificationRule(@Args('id', { type: () => ID }) id: string) {
    return this.ruleService.delete(id);
  }
}
