import {
  Args,
  ID,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { UserService } from '../user/service';
import { ChatMessage, Conversation, MessageFeedback } from './model';
import { ChatService } from './service';

@Resolver(() => Conversation)
export class ChatResolver {
  constructor(
    private readonly chatService: ChatService,
    private readonly userService: UserService,
  ) {}

  // サイドバーの履歴一覧(自分の会話のみ・新しい順)
  @Query(() => [Conversation])
  async conversations(@CurrentUser() authUser: AuthUser) {
    const user = await this.userService.ensure(authUser);
    return this.chatService.conversations(user.id);
  }

  @Query(() => Conversation)
  async conversation(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() authUser: AuthUser,
  ) {
    const user = await this.userService.ensure(authUser);
    return this.chatService.conversation(id, user.id);
  }

  // Conversationのmessagesフィールドが「実際に要求されたときだけ」実行される。
  // 親のConversationは上のQuery経由でしか取れず、そこで所有者チェック済み
  @ResolveField(() => [ChatMessage])
  messages(@Parent() conversation: Conversation) {
    return this.chatService.messages(conversation.id);
  }

  // 回答への評価(👍/👎)。同じものを押し直したときは画面側からnullが届く
  @Mutation(() => ChatMessage)
  async rateAnswer(
    @Args('messageId', { type: () => ID }) messageId: string,
    @CurrentUser() authUser: AuthUser,
    @Args('feedback', { type: () => MessageFeedback, nullable: true })
    feedback?: MessageFeedback | null,
    @Args('reason', { type: () => String, nullable: true })
    reason?: string | null,
  ) {
    const user = await this.userService.ensure(authUser);
    return this.chatService.rateAnswer(
      messageId,
      user.id,
      feedback ?? null,
      reason ?? null,
    );
  }

  // チャット名の変更(自分の会話のみ)
  @Mutation(() => Conversation)
  async renameConversation(
    @Args('id', { type: () => ID }) id: string,
    @Args('title') title: string,
    @CurrentUser() authUser: AuthUser,
  ) {
    const user = await this.userService.ensure(authUser);
    return this.chatService.renameConversation(id, user.id, title);
  }

  @Mutation(() => Conversation)
  async deleteConversation(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() authUser: AuthUser,
  ) {
    const user = await this.userService.ensure(authUser);
    return this.chatService.deleteConversation(id, user.id);
  }
}
