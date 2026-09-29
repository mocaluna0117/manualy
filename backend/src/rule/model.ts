import { Field, ID, ObjectType } from '@nestjs/graphql';

// 管理者がAIに教える分類ルール(自然文)
@ObjectType()
export class ClassificationRule {
  @Field(() => ID)
  id!: string;

  @Field()
  text!: string;

  @Field()
  createdAt!: Date;
}
