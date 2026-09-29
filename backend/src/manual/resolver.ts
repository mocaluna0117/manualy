import { BadRequestException } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { Roles, UserRole } from '../auth/roles';
import { UserService } from '../user/service';
import { SUPPORTED_EXTENSIONS, fileTypeOf } from '../storage/file-types';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';
import {
  AutoOrganizeResult,
  ClassifyConflict,
  DeleteEmptyCategoriesResult,
  LastReclassify,
  Manual,
  ManualDownloadTarget,
  ManualSearchResult,
  ManualUploadTarget,
  ManualViewTarget,
  ReclassifyCounts,
  ReclassifySelectedResult,
  ReclassifyStatus,
  RegisterManualResult,
  ResolveConflictResult,
  RestoreCategoriesResult,
  UndoReclassifyResult,
} from './model';
import { ManualCategory } from '../category/model';
import { ManualService } from './service';

@Resolver(() => Manual)
export class ManualResolver {
  constructor(
    private readonly manualService: ManualService,
    private readonly storageService: StorageService,
    private readonly userService: UserService,
  ) {}

  /** 管理者だけに見せるフォルダの中身まで返してよいか */
  private async isAdmin(authUser: AuthUser) {
    const user = await this.userService.ensure(authUser);
    return user.role === UserRole.ADMIN;
  }

  // 一覧。categoryIdで絞り込み、uncategorized=trueでカテゴリ未設定のみ
  @Query(() => [Manual])
  async manuals(
    @CurrentUser() authUser: AuthUser,
    @Args('categoryId', { type: () => ID, nullable: true })
    categoryId?: string,
    @Args('uncategorized', { type: () => Boolean, nullable: true })
    uncategorized?: boolean,
  ) {
    return this.manualService.findAll(
      categoryId,
      uncategorized,
      await this.isAdmin(authUser),
    );
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ManualUploadTarget)
  createManualUploadUrl(
    @Args('fileName') fileName: string,
  ): Promise<ManualUploadTarget> {
    // 対応形式の判定は file-types.ts に集約してある。
    // ここで独自に拡張子を見ると、形式を増やしたときに取りこぼす
    if (!fileTypeOf(fileName)) {
      throw new BadRequestException(
        `対応していない形式です。アップロードできるのは ${SUPPORTED_EXTENSIONS} です`,
      );
    }
    return this.storageService.createUploadUrl(fileName);
  }

  // キーワード検索(タイトル/説明/ファイル名/本文の部分一致)
  @Query(() => [ManualSearchResult])
  async searchManuals(
    @Args('keyword') keyword: string,
    @CurrentUser() authUser: AuthUser,
  ) {
    return this.manualService.search(keyword, await this.isAdmin(authUser));
  }

  // マニュアルを開くための署名付きURL(15分有効)と、形式の情報を返す
  @Query(() => ManualViewTarget)
  async manualDownloadUrl(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() authUser: AuthUser,
  ) {
    return this.manualService.getDownloadUrl(id, await this.isAdmin(authUser));
  }

  // 一括ダウンロード用。複数の署名付きURLをまとめて発行する
  // (閲覧できる人はダウンロードもできるので、権限は通常の認証のみ)
  @Query(() => [ManualDownloadTarget])
  async manualDownloadUrls(
    @Args('ids', { type: () => [ID] }) ids: string[],
    @CurrentUser() authUser: AuthUser,
  ) {
    return this.manualService.getDownloadTargets(
      ids,
      await this.isAdmin(authUser),
    );
  }

  // アップロード完了後にメタデータをDBへ登録。
  // 同名ファイルがある場合は最終更新日の新しい方を残す(outcomeで結果が分かる)
  @Roles(UserRole.ADMIN)
  @Mutation(() => RegisterManualResult)
  registerManual(@Args('input') input: RegisterManualInput) {
    return this.manualService.register(input);
  }

  // 別カテゴリへ移動(categoryId省略で未分類へ)
  @Roles(UserRole.ADMIN)
  @Mutation(() => Manual)
  moveManual(
    @Args('id', { type: () => ID }) id: string,
    @Args('categoryId', { type: () => ID, nullable: true })
    categoryId?: string,
  ) {
    return this.manualService.move(id, categoryId ?? null);
  }

  // 全マニュアルの再分類を開始する(数分かかるため裏で実行し、すぐ返す)。
  // 実行中だった場合はfalseを返す
  @Roles(UserRole.ADMIN)
  @Mutation(() => Boolean)
  startReclassifyAll(
    @Args('instruction', { type: () => String, nullable: true })
    instruction?: string,
  ) {
    return this.manualService.startReclassifyAll(instruction);
  }

  // 分類ルールが2つ以上当てはまって行き先が決まらず、動かさずに保留した分。
  // どちらが正しいかは運用の判断なのでAIに決めさせず、画面かチャットで選んでもらう
  @Roles(UserRole.ADMIN)
  @Query(() => [ClassifyConflict])
  pendingClassifyConflicts() {
    return this.manualService.pendingConflicts();
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ResolveConflictResult)
  resolveClassifyConflict(
    @Args('manualId', { type: () => ID }) manualId: string,
    // 省略・空なら「今のまま」にする(動かさずに保留だけ解く)
    @Args('category', { nullable: true }) category?: string,
  ) {
    return this.manualService.resolveConflict(manualId, category ?? null);
  }

  @Roles(UserRole.ADMIN)
  @Query(() => LastReclassify, { nullable: true })
  lastReclassify() {
    return this.manualService.lastReclassify();
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => UndoReclassifyResult)
  undoLastReclassify() {
    return this.manualService.undoLastReclassify();
  }

  @Roles(UserRole.ADMIN)
  @Query(() => ReclassifyStatus)
  reclassifyStatus() {
    return this.manualService.reclassifyStatusView();
  }

  // 再分類の対象件数(確認ダイアログの表示用)
  @Roles(UserRole.ADMIN)
  @Query(() => ReclassifyCounts)
  reclassifyCounts() {
    return this.manualService.reclassifyCounts();
  }

  // ピン留めの切り替え(ピン=AIの再分類で動かさない)
  @Roles(UserRole.ADMIN)
  @Mutation(() => Manual)
  setManualPinned(
    @Args('id', { type: () => ID }) id: string,
    @Args('pinned') pinned: boolean,
  ) {
    return this.manualService.setPinned(id, pinned);
  }

  // 未分類のマニュアルをAIでまとめて自動分類(カテゴリが無ければAIが命名して作る)
  @Roles(UserRole.ADMIN)
  @Mutation(() => AutoOrganizeResult)
  autoOrganizeManuals() {
    return this.manualService.autoOrganize();
  }

  // 複数まとめて移動。戻り値は移動した件数
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  moveManuals(
    @Args('ids', { type: () => [ID] }) ids: string[],
    @Args('categoryId', { type: () => ID, nullable: true })
    categoryId?: string,
  ) {
    return this.manualService.moveMany(ids, categoryId ?? null);
  }

  // DBの行とストレージの実ファイルを両方削除
  @Roles(UserRole.ADMIN)
  @Mutation(() => Manual)
  deleteManual(@Args('id', { type: () => ID }) id: string) {
    return this.manualService.delete(id);
  }

  // チェックしたファイルをまとめてゴミ箱へ。戻り値は移せた件数
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  deleteManuals(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.deleteMany(ids);
  }

  // ゴミ箱の中身
  @Roles(UserRole.ADMIN)
  @Query(() => [Manual])
  trashedManuals() {
    return this.manualService.trashed();
  }

  // ゴミ箱に入っているフォルダ(中身ごと捨てたもの)
  @Roles(UserRole.ADMIN)
  @Query(() => [ManualCategory])
  trashedCategories() {
    return this.manualService.trashedCategories();
  }

  // ゴミ箱から元に戻す
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  restoreManuals(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.restoreMany(ids);
  }

  // 画面に出る名前を変える(元のファイル名は変えない)
  @Roles(UserRole.ADMIN)
  @Mutation(() => Manual)
  renameManual(
    @Args('id', { type: () => ID }) id: string,
    @Args('title') title: string,
  ) {
    return this.manualService.rename(id, title);
  }

  // 選んだマニュアルだけをAIで分類し直す。
  // 既存のフォルダの中から選ばせる(新しいフォルダは作らない)
  @Roles(UserRole.ADMIN)
  @Mutation(() => ReclassifySelectedResult)
  reclassifySelectedManuals(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.reclassifySelected(ids);
  }

  // 空のフォルダだけをゴミ箱へ移す(再分類後の片付け)。
  // 中身が入っていたら見送るので、マニュアルが巻き添えで消えることはない
  @Roles(UserRole.ADMIN)
  @Mutation(() => DeleteEmptyCategoriesResult)
  deleteEmptyCategories(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.deleteEmptyCategories(ids);
  }

  // フォルダを中身ごと元に戻す
  @Roles(UserRole.ADMIN)
  @Mutation(() => RestoreCategoriesResult)
  restoreCategories(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.restoreCategories(ids);
  }

  // フォルダを中身ごと完全に削除する
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  purgeCategories(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.purgeCategories(ids);
  }

  // ゴミ箱から完全に削除する(実ファイルごと消える)
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  purgeManuals(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.purgeMany(ids);
  }

  // ゴミ箱を空にする
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  emptyTrash() {
    return this.manualService.emptyTrash();
  }

  // PDFをRAGに取り込む(チャンク化)。開始したらすぐ返す
  @Roles(UserRole.ADMIN)
  @Mutation(() => Boolean)
  ingestManual(@Args('id', { type: () => ID }) id: string) {
    // 完了は待たない。進行状況はマニュアルのingestStatusで確認する
    return this.manualService.startIngest(id);
  }
}
