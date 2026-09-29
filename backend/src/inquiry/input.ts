import { Field, InputType } from '@nestjs/graphql';

/** 問い合わせに添える画像1枚分 */
@InputType()
export class InquiryImageInput {
  @Field()
  base64!: string;

  /** png / jpeg / webp / gif */
  @Field()
  format!: string;
}
