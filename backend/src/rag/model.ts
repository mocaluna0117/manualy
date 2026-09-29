import { Field, Int, ObjectType } from '@nestjs/graphql';

// 回答の根拠となったマニュアルの断片
@ObjectType()
export class RagCitation {
  @Field()
  manualId!: string;

  @Field()
  title!: string;

  @Field()
  snippet!: string;

  // 元PDFの何ページ目か(ページ単位のピンポイント引用)
  @Field(() => Int, { nullable: true })
  pageNumber!: number | null;
}

@ObjectType()
export class RagAnswer {
  @Field()
  answer!: string;

  @Field(() => [RagCitation])
  citations!: RagCitation[];

  // 絞り込み質問の選択肢(フロントでボタン表示する)
  @Field(() => [String])
  options!: string[];

  // マニュアルから答えられたか(null=判断材料なし)。画面には出さず、
  // 「答えられなかった質問」の集計のためにDBへ記録する
  answered?: boolean | null;

  // 判定できなかった理由まで分かる結末(answeredはここから導かれている)。
  // 集計で「対象外(聞き返し・管理操作)」と「判定漏れ」を分けるために使う
  outcome?: string | null;
}
