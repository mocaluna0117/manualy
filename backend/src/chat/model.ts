import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { MessageFeedback, MessageRole } from '../../generated/prisma/client';
import { RagCitation } from '../rag/model';

registerEnumType(MessageRole, {
  name: 'MessageRole',
  description: 'メッセージの発言者(USER=質問 / ASSISTANT=AI回答)',
});

registerEnumType(MessageFeedback, {
  name: 'MessageFeedback',
  description: '回答への評価(GOOD=役に立った / BAD=役に立たなかった)',
});

export { MessageFeedback, MessageRole };

@ObjectType()
export class ChatMessage {
  @Field(() => ID)
  id!: string;

  @Field(() => MessageRole)
  role!: MessageRole;

  @Field()
  content!: string;

  // 回答の根拠マニュアル(USERメッセージでは常に空)
  @Field(() => [RagCitation])
  citations!: RagCitation[];

  // 絞り込み質問の選択肢(クリックで回答できるボタンになる)
  @Field(() => [String])
  options!: string[];

  // 質問に添えた画像の表示用URL(署名付き・15分有効)。添付が無ければ空
  @Field(() => [String])
  imageUrls!: string[];

  // 回答への評価(未評価はnull)。押し直しで取り消せる
  @Field(() => MessageFeedback, { nullable: true })
  feedback!: MessageFeedback | null;

  // 👎のときに選ばれた理由(任意)
  @Field(() => String, { nullable: true })
  feedbackReason!: string | null;

  @Field()
  createdAt!: Date;
}

@ObjectType()
export class Conversation {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  // messagesはここに書かず@ResolveFieldで遅延取得する(resolver参照)

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

/**
 * 質問への応答。新規会話の場合はconversationIdで新しいIDを知らせる。
 *
 * GraphQLの型ではない(回答はSSEの /chat/stream で返しており、
 * これはサーバー内部とSSEの本文で使う形)
 */
export interface AskResult {
  conversationId: string;
  message: ChatMessage;
}
