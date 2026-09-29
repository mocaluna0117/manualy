import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Roles, UserRole } from '../auth/roles';
import { PromptTemplate } from './model';
import { TemplateService } from './service';

@Resolver(() => PromptTemplate)
export class TemplateResolver {
  constructor(private readonly templateService: TemplateService) {}

  // 一覧は全員が使う(チャット入力欄の定型文)
  @Query(() => [PromptTemplate])
  promptTemplates() {
    return this.templateService.findAll();
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => PromptTemplate)
  createPromptTemplate(
    @Args('title') title: string,
    @Args('body') body: string,
  ) {
    return this.templateService.create(title, body);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => PromptTemplate)
  updatePromptTemplate(
    @Args('id', { type: () => ID }) id: string,
    @Args('title') title: string,
    @Args('body') body: string,
  ) {
    return this.templateService.update(id, title, body);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => PromptTemplate)
  deletePromptTemplate(@Args('id', { type: () => ID }) id: string) {
    return this.templateService.delete(id);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  reorderPromptTemplates(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.templateService.reorder(ids);
  }
}
