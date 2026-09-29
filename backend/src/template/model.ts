import { Field, ID, ObjectType } from '@nestjs/graphql';

// チャット入力欄に挿し込める定型文
@ObjectType()
export class PromptTemplate {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  body!: string;
}
