import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { RagCitation } from '../rag/model';

/** AIがマニュアルから答えられなかった質問(=足りていないマニュアルの手がかり) */
@ObjectType()
export class UnansweredQuestion {
  @Field(() => ID)
  id!: string;

  @Field()
  question!: string;

  // そのときAIが返した回答。なぜ答えられなかったかの手がかりになる
  @Field()
  answer!: string;

  @Field(() => Date)
  askedAt!: Date;

  // 人が👎を押したもの(AIの判定ではなく利用者の判断で拾われた)
  @Field()
  ratedBad!: boolean;

  // 👎のときに選ばれた理由(任意)
  @Field(() => String, { nullable: true })
  feedbackReason!: string | null;
}

/** 答えられなかった質問から作ったマニュアルの下書き */
@ObjectType()
export class ManualDraft {
  // Markdownの本文(そのままコピーして清書に使える形)
  @Field()
  draft!: string;

  // 下書きの材料にした既存マニュアル(近い資料が既にあることの手がかり)
  @Field(() => [RagCitation])
  sources!: RagCitation[];
}

/** 質問をテーマごとにまとめたもの(AIが意味の近さで束ねる) */
@ObjectType()
export class QuestionTheme {
  @Field()
  theme!: string;

  @Field(() => Int)
  count!: number;

  // 代表的な質問文(最大3件)
  @Field(() => [String])
  examples!: string[];
}

/** マニュアルが回答の根拠として何回使われたか */
@ObjectType()
export class ManualUsage {
  @Field(() => ID)
  manualId!: string;

  @Field()
  title!: string;

  // 所属フォルダ名(未分類はnull)
  @Field(() => String, { nullable: true })
  categoryName!: string | null;

  @Field(() => Int)
  citedCount!: number;

  // 最後に引用された日時(一度も使われていなければnull)
  @Field(() => Date, { nullable: true })
  lastCitedAt!: Date | null;
}

/** 利用状況のまとめ(集計対象の期間と件数) */
@ObjectType()
export class AnalyticsSummary {
  // 集計対象の質問数
  @Field(() => Int)
  questionCount!: number;

  // マニュアルから答えられた回答数
  @Field(() => Int)
  answeredCount!: number;

  // 答えられなかった回答数
  @Field(() => Int)
  unansweredCount!: number;

  // 可否を判定できない回答数(内訳を出せない場合の合計。古い画面との互換用)
  @Field(() => Int)
  unknownCount!: number;

  // 数える意味が無い回答数(聞き返し・管理操作・検索対象ゼロ)
  @Field(() => Int)
  outOfScopeCount!: number;

  // 回答文の生成に失敗した数(マニュアルの有無とは無関係の障害)
  @Field(() => Int)
  failedCount!: number;

  // 通常の回答なのにAIが根拠を申告せず、可否を判定できなかった数
  @Field(() => Int)
  unreportedCount!: number;

  // 結末を記録し始める前に保存されたデータの数
  @Field(() => Int)
  notRecordedCount!: number;

  // 人が👍を押した数
  @Field(() => Int)
  ratedGoodCount!: number;

  // 人が👎を押した数
  @Field(() => Int)
  ratedBadCount!: number;

  // 一度も引用されていないマニュアルの数
  @Field(() => Int)
  neverCitedManualCount!: number;
}
