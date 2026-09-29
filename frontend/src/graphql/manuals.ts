import { gql, type TypedDocumentNode } from "@apollo/client";

// --- アップロード先URLの発行 ---

interface CreateUploadUrlData {
  createManualUploadUrl: {
    uploadUrl: string;
    fileKey: string;
  };
}

interface CreateUploadUrlVars {
  fileName: string;
}

export const CREATE_UPLOAD_URL_MUTATION: TypedDocumentNode<
  CreateUploadUrlData,
  CreateUploadUrlVars
> = gql`
  mutation CreateManualUploadUrl($fileName: String!) {
    createManualUploadUrl(fileName: $fileName) {
      uploadUrl
      fileKey
    }
  }
`;

// --- アップロード完了後のDB登録 ---

export type IngestStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface Manual {
  id: string;
  title: string;
  fileName: string;
  size: number;
  categoryId: string | null;
  ingestStatus: IngestStatus;
  ingestError: string | null;
  chunkCount: number | null;
  updatedAt: string; // DBの更新時刻(並べ替えの保険用)
  // 元ファイル自体の最終更新日(「更新日」列)。この項目より前に
  // 登録されたものはnullなので、その場合は登録日で代用する
  fileLastModified: string | null;
  createdAt: string; // このアプリに登録した日時
  pdfCreatedAt: string | null; // PDF自体が持つ作成日
  categoryPinned: boolean; // ピン留め済み(AIの再分類で動かない)
  deletedAt?: string | null; // ゴミ箱に入れた日時
}

/** 同名ファイルをアップロードしたときの結果 */
export type RegisterOutcome = "CREATED" | "UPDATED" | "SKIPPED_OLDER";

interface RegisterManualData {
  registerManual: {
    manual: Manual;
    outcome: RegisterOutcome;
    // 判定に使った更新日時(nullは「不明で比較できなかった」)
    existingFileLastModified: string | null;
    incomingFileLastModified: string | null;
  };
}

interface RegisterManualVars {
  input: {
    title: string;
    fileKey: string;
    fileName: string;
    size: number;
    categoryId?: string;
    autoCategorize?: boolean;
    fileLastModified?: string; // ISO8601。同名アップロード時の新旧判定に使う
    forceReplace?: boolean; // スキップされた後に「それでも差し替える」で使う
  };
}

export const REGISTER_MANUAL_MUTATION: TypedDocumentNode<
  RegisterManualData,
  RegisterManualVars
> = gql`
  mutation RegisterManual($input: RegisterManualInput!) {
    registerManual(input: $input) {
      outcome
      existingFileLastModified
      incomingFileLastModified
      manual {
        id
        title
        fileName
        size
        categoryId
      }
    }
  }
`;

// --- 一覧(カテゴリ絞り込み対応) ---

interface ManualsData {
  manuals: Manual[];
}

interface ManualsVars {
  categoryId?: string;
  uncategorized?: boolean;
}

export const MANUALS_QUERY: TypedDocumentNode<ManualsData, ManualsVars> = gql`
  query Manuals($categoryId: ID, $uncategorized: Boolean) {
    manuals(categoryId: $categoryId, uncategorized: $uncategorized) {
      id
      title
      fileName
      size
      categoryId
      ingestStatus
      ingestError
      chunkCount
      updatedAt
      fileLastModified
      createdAt
      pdfCreatedAt
      categoryPinned
    }
  }
`;

// --- ピン留めの切り替え(ADMIN専用。ピン=AIの再分類で動かさない) ---

interface SetManualPinnedData {
  setManualPinned: { id: string; categoryPinned: boolean };
}

interface SetManualPinnedVars {
  id: string;
  pinned: boolean;
}

export const SET_MANUAL_PINNED_MUTATION: TypedDocumentNode<
  SetManualPinnedData,
  SetManualPinnedVars
> = gql`
  mutation SetManualPinned($id: ID!, $pinned: Boolean!) {
    setManualPinned(id: $id, pinned: $pinned) {
      id
      categoryPinned
    }
  }
`;

// --- 取り込みの再試行(FAILEDになったとき用) ---

interface IngestManualData {
  ingestManual: boolean; // 開始できたらtrue(完了は待たない)
}

interface IngestManualVars {
  id: string;
}

export const INGEST_MANUAL_MUTATION: TypedDocumentNode<
  IngestManualData,
  IngestManualVars
> = gql`
  mutation IngestManual($id: ID!) {
    ingestManual(id: $id)
  }
`;

// --- キーワード検索 ---

export interface ManualSearchResult {
  manual: Manual;
  snippet: string | null;
}

interface SearchManualsData {
  searchManuals: ManualSearchResult[];
}

interface SearchManualsVars {
  keyword: string;
}

export const SEARCH_MANUALS_QUERY: TypedDocumentNode<
  SearchManualsData,
  SearchManualsVars
> = gql`
  query SearchManuals($keyword: String!) {
    searchManuals(keyword: $keyword) {
      manual {
        id
        title
        fileName
        size
        categoryId
        ingestStatus
        ingestError
        chunkCount
        updatedAt
        fileLastModified
        createdAt
        pdfCreatedAt
        categoryPinned
      }
      snippet
    }
  }
`;

// --- まとめて削除(ADMIN専用) ---

interface DeleteManualsData {
  deleteManuals: number;
}

interface DeleteManualsVars {
  ids: string[];
}

export const DELETE_MANUALS_MUTATION: TypedDocumentNode<
  DeleteManualsData,
  DeleteManualsVars
> = gql`
  mutation DeleteManuals($ids: [ID!]!) {
    deleteManuals(ids: $ids)
  }
`;

// --- ゴミ箱(ADMIN専用) ---

interface TrashedManualsData {
  trashedManuals: Manual[];
}

export const TRASHED_MANUALS_QUERY: TypedDocumentNode<TrashedManualsData> = gql`
  query TrashedManuals {
    trashedManuals {
      id
      title
      fileName
      size
      categoryId
      ingestStatus
      ingestError
      chunkCount
      updatedAt
      fileLastModified
      createdAt
      pdfCreatedAt
      categoryPinned
      deletedAt
    }
  }
`;

interface TrashedCategoriesData {
  trashedCategories: {
    id: string;
    name: string;
    deletedAt?: string | null;
    manualCount?: number;
    totalSize?: number;
  }[];
}

export const TRASHED_CATEGORIES_QUERY: TypedDocumentNode<TrashedCategoriesData> = gql`
  query TrashedCategories {
    trashedCategories {
      id
      name
      deletedAt
      manualCount
      totalSize
    }
  }
`;

interface TrashActionData {
  restoreManuals?: number;
  purgeManuals?: number;
  emptyTrash?: number;
  restoreCategories?: number;
  purgeCategories?: number;
}

interface IdsVars {
  ids: string[];
}

export const RESTORE_MANUALS_MUTATION: TypedDocumentNode<
  TrashActionData,
  IdsVars
> = gql`
  mutation RestoreManuals($ids: [ID!]!) {
    restoreManuals(ids: $ids)
  }
`;

export const PURGE_MANUALS_MUTATION: TypedDocumentNode<
  TrashActionData,
  IdsVars
> = gql`
  mutation PurgeManuals($ids: [ID!]!) {
    purgeManuals(ids: $ids)
  }
`;

interface RestoreCategoriesData {
  restoreCategories: {
    restoredCount: number;
    // 同名のフォルダが既にあったため、中身だけをそちらへ戻した分
    mergedInto: string[];
    /** 鍵の有無が違ったため、まとめずに別の名前で戻した分 */
    restoredSeparately: string[];
  };
}

export const RESTORE_CATEGORIES_MUTATION: TypedDocumentNode<
  RestoreCategoriesData,
  IdsVars
> = gql`
  mutation RestoreCategories($ids: [ID!]!) {
    restoreCategories(ids: $ids) {
      restoredCount
      mergedInto
      restoredSeparately
    }
  }
`;

export const PURGE_CATEGORIES_MUTATION: TypedDocumentNode<
  TrashActionData,
  IdsVars
> = gql`
  mutation PurgeCategories($ids: [ID!]!) {
    purgeCategories(ids: $ids)
  }
`;

export const EMPTY_TRASH_MUTATION: TypedDocumentNode<TrashActionData> = gql`
  mutation EmptyTrash {
    emptyTrash
  }
`;

// --- 一括ダウンロード用のURL発行 ---

export interface ManualDownloadTarget {
  id: string;
  title: string;
  fileName: string;
  url: string;
}

interface DownloadUrlsData {
  manualDownloadUrls: ManualDownloadTarget[];
}

interface DownloadUrlsVars {
  ids: string[];
}

export const MANUAL_DOWNLOAD_URLS_QUERY: TypedDocumentNode<
  DownloadUrlsData,
  DownloadUrlsVars
> = gql`
  query ManualDownloadUrls($ids: [ID!]!) {
    manualDownloadUrls(ids: $ids) {
      id
      title
      fileName
      url
    }
  }
`;

// --- 閲覧用URLの発行 ---

interface DownloadUrlData {
  manualDownloadUrl: {
    url: string;
    fileName: string;
    /** trueならタブで開ける(PDF)。falseならダウンロードして開いてもらう */
    viewableInBrowser: boolean;
  };
}

interface DownloadUrlVars {
  id: string;
}

export const MANUAL_DOWNLOAD_URL_QUERY: TypedDocumentNode<
  DownloadUrlData,
  DownloadUrlVars
> = gql`
  query ManualDownloadUrl($id: ID!) {
    manualDownloadUrl(id: $id) {
      url
      fileName
      viewableInBrowser
    }
  }
`;

// --- 表示名の変更(ADMIN専用。元のファイル名は変わらない) ---

interface RenameManualData {
  renameManual: Pick<Manual, "id" | "title">;
}

export const RENAME_MANUAL_MUTATION: TypedDocumentNode<
  RenameManualData,
  { id: string; title: string }
> = gql`
  mutation RenameManual($id: ID!, $title: String!) {
    renameManual(id: $id, title: $title) {
      id
      title
    }
  }
`;

// --- カテゴリ間の移動(ADMIN専用) ---

interface MoveManualData {
  moveManual: Pick<Manual, "id" | "categoryId">;
}

interface MoveManualVars {
  id: string;
  categoryId: string | null;
}

export const MOVE_MANUAL_MUTATION: TypedDocumentNode<
  MoveManualData,
  MoveManualVars
> = gql`
  mutation MoveManual($id: ID!, $categoryId: ID) {
    moveManual(id: $id, categoryId: $categoryId) {
      id
      categoryId
    }
  }
`;

// --- 選んだマニュアルだけを分類し直す(ADMIN専用) ---

interface ReclassifySelectedData {
  reclassifySelectedManuals: {
    movedCount: number;
    moved: { title: string; categoryName: string; adminOnly: boolean }[];
    /** ピン留めされていて動かさなかった分 */
    skippedPinned: string[];
    /** 取り込みが終わっておらず中身を読めなかった分 */
    skippedNotReady: string[];
    /** 鍵付きフォルダの中にあって動かさなかった分 */
    skippedLocked: string[];
    /** 合うフォルダが無くて新しく作った分 */
    createdCategories: string[];
    /** ルールが2つ以上当てはまり、行き先を選んでもらう分 */
    conflictedCount: number;
  };
}

export const RECLASSIFY_SELECTED_MUTATION: TypedDocumentNode<
  ReclassifySelectedData,
  { ids: string[] }
> = gql`
  mutation ReclassifySelectedManuals($ids: [ID!]!) {
    reclassifySelectedManuals(ids: $ids) {
      movedCount
      moved {
        title
        categoryName
        adminOnly
      }
      skippedPinned
      skippedNotReady
      skippedLocked
      createdCategories
      conflictedCount
    }
  }
`;

// --- AIによる自動分類(ADMIN専用) ---

interface AutoOrganizeData {
  autoOrganizeManuals: {
    movedCount: number;
    createdCategories: string[];
    /** 鍵付きフォルダへ入れた分(一般利用者からは見えなくなる) */
    movedToLocked: string[];
    /** ルールが2つ以上当てはまり、行き先を選んでもらう分 */
    conflictedCount: number;
  };
}

export const AUTO_ORGANIZE_MUTATION: TypedDocumentNode<AutoOrganizeData> = gql`
  mutation AutoOrganizeManuals {
    autoOrganizeManuals {
      movedCount
      createdCategories
      movedToLocked
      conflictedCount
    }
  }
`;

// --- 全件再分類(ADMIN専用)。数分かかるので開始と進捗確認を分ける ---

interface StartReclassifyData {
  startReclassifyAll: boolean; // falseなら既に実行中
}

export const START_RECLASSIFY_MUTATION: TypedDocumentNode<StartReclassifyData> = gql`
  mutation StartReclassifyAll {
    startReclassifyAll
  }
`;

/** 再分類で中身が他へ移り、空になったフォルダ */
export interface EmptiedCategory {
  id: string;
  name: string;
  /** AIの自動分類が作ったフォルダか。falseなら利用者が自分で作った箱 */
  createdByAi: boolean;
}

export interface ReclassifyStatus {
  running: boolean;
  movedCount: number;
  createdCategories: string[];
  emptiedCategories: EmptiedCategory[];
  /** 鍵付きフォルダへ入れた分(一般利用者からは見えなくなる) */
  movedToLocked: string[];
  /** 鍵付きフォルダの中にあって動かさなかった分 */
  skippedLocked: string[];
  error: string | null;
  finishedAt: string | null;
}

interface DeleteEmptyCategoriesData {
  deleteEmptyCategories: {
    /** 実際に消したフォルダのID */
    deletedIds: string[];
    /** 中身が入っていて消さなかったフォルダ名 */
    skipped: string[];
  };
}

export const DELETE_EMPTY_CATEGORIES_MUTATION: TypedDocumentNode<
  DeleteEmptyCategoriesData,
  { ids: string[] }
> = gql`
  mutation DeleteEmptyCategories($ids: [ID!]!) {
    deleteEmptyCategories(ids: $ids) {
      deletedIds
      skipped
    }
  }
`;

interface ReclassifyStatusData {
  reclassifyStatus: ReclassifyStatus;
}

export const RECLASSIFY_STATUS_QUERY: TypedDocumentNode<ReclassifyStatusData> = gql`
  query ReclassifyStatus {
    reclassifyStatus {
      running
      movedCount
      createdCategories
      emptiedCategories {
        id
        name
        createdByAi
      }
      movedToLocked
      skippedLocked
      error
      finishedAt
    }
  }
`;

// --- 分類ルールが食い違って保留になったもの(ADMIN専用) ---

export interface ClassifyConflict {
  manualId: string;
  title: string;
  /** いま入っているフォルダ(未分類ならnull)。選ぶまで動かさない */
  currentCategory: string | null;
  /** 行き先の候補 */
  candidates: string[];
}

interface ConflictsData {
  pendingClassifyConflicts: ClassifyConflict[];
}

export const CLASSIFY_CONFLICTS_QUERY: TypedDocumentNode<ConflictsData> = gql`
  query PendingClassifyConflicts {
    pendingClassifyConflicts {
      manualId
      title
      currentCategory
      candidates
    }
  }
`;

interface ResolveConflictData {
  resolveClassifyConflict: { movedTo: string | null; remaining: number };
}

export const RESOLVE_CONFLICT_MUTATION: TypedDocumentNode<
  ResolveConflictData,
  { manualId: string; category?: string | null }
> = gql`
  mutation ResolveClassifyConflict($manualId: ID!, $category: String) {
    resolveClassifyConflict(manualId: $manualId, category: $category) {
      movedTo
      remaining
    }
  }
`;

// --- 直前の再分類を元に戻す(ADMIN専用) ---

export interface LastReclassify {
  id: string;
  /** ALL=全件再分類 / SELECTED=選んだ分 / UNCATEGORIZED=未分類をまとめて */
  kind: string;
  movedCount: number;
  /** この再分類でAIが新しく作ったフォルダ(元に戻すと空になる) */
  createdCategories: string[];
  createdAt: string;
}

interface LastReclassifyData {
  lastReclassify: LastReclassify | null;
}

export const LAST_RECLASSIFY_QUERY: TypedDocumentNode<LastReclassifyData> = gql`
  query LastReclassify {
    lastReclassify {
      id
      kind
      movedCount
      createdCategories
      createdAt
    }
  }
`;

interface UndoReclassifyData {
  undoLastReclassify: {
    restoredCount: number;
    /** 再分類のあとに人が動かしたため、触らなかった件数 */
    skippedCount: number;
    skipped: string[];
    createdCategories: string[];
  };
}

export const UNDO_RECLASSIFY_MUTATION: TypedDocumentNode<UndoReclassifyData> = gql`
  mutation UndoLastReclassify {
    undoLastReclassify {
      restoredCount
      skippedCount
      skipped
      createdCategories
    }
  }
`;

interface ReclassifyCountsData {
  reclassifyCounts: { target: number; pinned: number; locked: number };
}

export const RECLASSIFY_COUNTS_QUERY: TypedDocumentNode<ReclassifyCountsData> = gql`
  query ReclassifyCounts {
    reclassifyCounts {
      target
      pinned
      locked
    }
  }
`;

// --- まとめて移動(ADMIN専用) ---

interface MoveManualsData {
  moveManuals: number;
}

interface MoveManualsVars {
  ids: string[];
  categoryId: string | null;
}

export const MOVE_MANUALS_MUTATION: TypedDocumentNode<
  MoveManualsData,
  MoveManualsVars
> = gql`
  mutation MoveManuals($ids: [ID!]!, $categoryId: ID) {
    moveManuals(ids: $ids, categoryId: $categoryId)
  }
`;

// --- 削除 ---

interface DeleteManualData {
  deleteManual: Pick<Manual, "id" | "title">;
}

interface DeleteManualVars {
  id: string;
}

export const DELETE_MANUAL_MUTATION: TypedDocumentNode<
  DeleteManualData,
  DeleteManualVars
> = gql`
  mutation DeleteManual($id: ID!) {
    deleteManual(id: $id) {
      id
      title
    }
  }
`;
