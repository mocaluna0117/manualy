import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IngestStatus } from '../../generated/prisma/client';

// Prismaのenumを、GraphQLスキーマでも使えるように登録する
registerEnumType(IngestStatus, {
  name: 'IngestStatus',
  description: 'PDF取り込みの進行状況',
});

export { IngestStatus };

// アップロード先の情報。フロントはuploadUrlへファイルをPUTし、
// 完了後にfileKeyを添えてregisterManualを呼ぶ
@ObjectType()
export class ManualUploadTarget {
  @Field()
  uploadUrl!: string;

  @Field()
  fileKey!: string;
}

@ObjectType()
export class Manual {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  fileKey!: string;

  @Field()
  fileName!: string;

  // 元ファイルの最終更新日時(同名アップロード時の新旧判定に使う)
  @Field(() => Date, { nullable: true })
  fileLastModified!: Date | null;

  // PDF自体が持つ作成日(取り込み時に読み取る)。一覧の「作成日」列に使う
  @Field(() => Date, { nullable: true })
  pdfCreatedAt!: Date | null;

  @Field()
  mimeType!: string;

  @Field(() => Int)
  size!: number;

  @Field(() => ID, { nullable: true })
  categoryId!: string | null;

  // trueなら手動で分類済み(ピン留め)。AIの再分類では動かさない
  @Field()
  categoryPinned!: boolean;

  @Field(() => IngestStatus)
  ingestStatus!: IngestStatus;

  @Field(() => String, { nullable: true })
  ingestError!: string | null;

  @Field(() => Int, { nullable: true })
  chunkCount!: number | null;

  // ゴミ箱に入った日時(nullなら通常のマニュアル)
  @Field(() => Date, { nullable: true })
  deletedAt!: Date | null;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

// 同名ファイルをアップロードしたときの登録結果の種別
export enum RegisterOutcome {
  CREATED = 'CREATED', // 新規追加
  UPDATED = 'UPDATED', // 同名の既存マニュアルを新しい版で置き換えた
  SKIPPED_OLDER = 'SKIPPED_OLDER', // 既存の方が新しいため取り込まなかった
}

registerEnumType(RegisterOutcome, {
  name: 'RegisterOutcome',
  description: '登録結果(新規/既存を更新/古いためスキップ)',
});

@ObjectType()
export class RegisterManualResult {
  @Field(() => Manual)
  manual!: Manual;

  @Field(() => RegisterOutcome)
  outcome!: RegisterOutcome;

  // 判定に使った2つの更新日時。スキップされた理由を画面で説明するために返す
  // (nullは「その情報が無い」= 比較できなかったことを意味する)
  @Field(() => Date, { nullable: true })
  existingFileLastModified?: Date | null;

  @Field(() => Date, { nullable: true })
  incomingFileLastModified?: Date | null;
}

// 分類ルールが食い違って保留になっているマニュアル
@ObjectType()
export class ClassifyConflict {
  @Field(() => ID)
  manualId!: string;

  @Field()
  title!: string;

  // 今入っているフォルダ(未分類ならnull)。動かしていないので今のまま
  @Field(() => String, { nullable: true })
  currentCategory!: string | null;

  // 行き先の候補。この中から利用者が選ぶ
  @Field(() => [String])
  candidates!: string[];
}

// 保留を1件解決した結果
@ObjectType()
export class ResolveConflictResult {
  // 実際に入れたフォルダ。「今のまま」を選んだ場合はnull
  @Field(() => String, { nullable: true })
  movedTo!: string | null;

  // まだ残っている保留の件数
  @Field(() => Int)
  remaining!: number;
}

// 直前の再分類(まだ元に戻していないもの)。画面に「元に戻す」を出すかの判断に使う
@ObjectType()
export class LastReclassify {
  @Field(() => ID)
  id!: string;

  // ALL=全件再分類 / SELECTED=選んだ分 / UNCATEGORIZED=未分類をまとめて
  @Field()
  kind!: string;

  @Field(() => Int)
  movedCount!: number;

  // この再分類でAIが新しく作ったフォルダ(元に戻すと空になる)
  @Field(() => [String])
  createdCategories!: string[];

  @Field(() => Date)
  createdAt!: Date;
}

// 元に戻した結果
@ObjectType()
export class UndoReclassifyResult {
  @Field(() => Int)
  restoredCount!: number;

  // 再分類のあとに人が動かしたため、触らなかった件数
  @Field(() => Int)
  skippedCount!: number;

  @Field(() => [String])
  skipped!: string[];

  // 元に戻したことで空になった可能性のあるフォルダ
  @Field(() => [String])
  createdCategories!: string[];
}

// AI自動分類の実行結果
@ObjectType()
export class AutoOrganizeResult {
  // ルールが2つ以上当てはまって行き先が決まらず、動かさなかった件数。
  // 画面の「分類の判断待ち」から選んでもらう
  @Field(() => Int)
  conflictedCount!: number;

  @Field(() => Int)
  movedCount!: number;

  @Field(() => [String])
  createdCategories!: string[];

  // 鍵付きフォルダへ入れたマニュアルの名前(一般利用者からは見えなくなる)
  @Field(() => [String])
  movedToLocked!: string[];
}

// 再分類で中身が他へ移り、空になったフォルダ。
// 消すかどうかは利用者が決めるので、候補として返すだけ
@ObjectType()
export class EmptiedCategory {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  // AIの自動分類が作ったフォルダか。falseなら利用者が自分で作った箱なので、
  // 画面ではそれと分かるようにして、既定では消す対象から外す
  @Field()
  createdByAi!: boolean;
}

// 選んだマニュアルを分類し直した結果
@ObjectType()
export class ReclassifiedManual {
  @Field()
  title!: string;

  @Field()
  categoryName!: string;

  // 入れた先が鍵付きフォルダか。画面で🔒を出して、
  // 一般利用者から見えなくなったことを管理者に伝える
  @Field()
  adminOnly!: boolean;
}

@ObjectType()
export class ReclassifySelectedResult {
  // ルールが2つ以上当てはまって行き先が決まらず、動かさなかった件数。
  // 画面の「分類の判断待ち」から選んでもらう
  @Field(() => Int)
  conflictedCount!: number;

  @Field(() => Int)
  movedCount!: number;

  // 実際にどこへ入ったか(1件ずつ画面で見せる)
  @Field(() => [ReclassifiedManual])
  moved!: ReclassifiedManual[];

  // ピン留めされていて動かさなかったマニュアルの名前
  @Field(() => [String])
  skippedPinned!: string[];

  // 取り込みが終わっておらず、中身を読めなかったマニュアルの名前
  @Field(() => [String])
  skippedNotReady!: string[];

  // 鍵付きフォルダの中にあって動かさなかったマニュアルの名前。
  // AIの分類で鍵の外へ出すと、隠していた資料が全員に見えてしまうため
  @Field(() => [String])
  skippedLocked!: string[];

  // 合うフォルダが無くて新しく作った分の名前
  @Field(() => [String])
  createdCategories!: string[];
}

// 空フォルダの片付け結果
@ObjectType()
export class DeleteEmptyCategoriesResult {
  // 実際に消したフォルダ。画面側が「開いていたフォルダを消したか」を
  // 判定できるよう、件数ではなくIDを返す
  @Field(() => [ID])
  deletedIds!: string[];

  // 実行するまでに中身が入った等で消さなかったフォルダ名。
  // 黙って見送るとマニュアルごと消えたように見えるため必ず伝える
  @Field(() => [String])
  skipped!: string[];
}

// 全件再分類の進行状況。数分かかるためリクエストは待たせず、
// フロントはこの状態をポーリングして完了を知る
@ObjectType()
export class ReclassifyStatus {
  @Field()
  running!: boolean;
  // ルールが2つ以上当てはまって行き先が決まらず、動かさなかった件数。
  // 画面の「分類の判断待ち」から選んでもらう
  @Field(() => Int)
  conflictedCount!: number;

  @Field(() => Int)
  movedCount!: number;

  @Field(() => [String])
  createdCategories!: string[];

  // この再分類で中身が無くなったフォルダ(もともと空だったものは含まない)
  @Field(() => [EmptiedCategory])
  emptiedCategories!: EmptiedCategory[];

  // 鍵付きフォルダへ入れたマニュアルの名前(一般利用者からは見えなくなる)
  @Field(() => [String])
  movedToLocked!: string[];

  // 鍵付きフォルダの中にあって動かさなかったマニュアルの名前
  @Field(() => [String])
  skippedLocked!: string[];

  @Field(() => String, { nullable: true })
  error!: string | null;

  @Field(() => Date, { nullable: true })
  finishedAt!: Date | null;
}

// フォルダの復元結果。同名のフォルダが既にあった場合は、中身だけを
// そちらへ移すため、どのフォルダがそうなったかを画面に伝える
@ObjectType()
export class RestoreCategoriesResult {
  @Field(() => Int)
  restoredCount!: number;

  @Field(() => [String])
  mergedInto!: string[];

  // 同名のフォルダと見せる範囲(鍵)が違ったため、まとめずに別の名前で戻した分。
  // まとめると鍵付きだった中身が全員に見えてしまう(またはその逆になる)
  @Field(() => [String])
  restoredSeparately!: string[];
}

// マニュアルを開くための情報。ブラウザで表示できない形式(Word/Excel等)は
// ダウンロードさせるので、画面が判断できるよう形式も一緒に返す
@ObjectType()
export class ManualViewTarget {
  @Field()
  url!: string;

  @Field()
  fileName!: string;

  // trueならタブで開ける(PDF)。falseならダウンロードして開いてもらう
  @Field()
  viewableInBrowser!: boolean;
}

// 一括ダウンロードの対象1件分(署名付きURL付き)
@ObjectType()
export class ManualDownloadTarget {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  fileName!: string;

  @Field()
  url!: string;
}

// 再分類の確認ダイアログに出す件数
@ObjectType()
export class ReclassifyCounts {
  @Field(() => Int)
  target!: number; // 再分類の対象(ピン留めを除く)

  @Field(() => Int)
  pinned!: number; // ピン留めされていて動かさない件数

  @Field(() => Int)
  locked!: number; // 鍵付きフォルダの中にあって動かさない件数
}

// キーワード検索の1件分。マニュアル本体と、本文がヒットした場合はその抜粋を返す
@ObjectType()
export class ManualSearchResult {
  @Field(() => Manual)
  manual!: Manual;

  @Field(() => String, { nullable: true })
  snippet!: string | null;
}
