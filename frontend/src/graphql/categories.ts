import { gql, type TypedDocumentNode } from '@apollo/client'

export interface Category {
  id: string
  name: string
  updatedAt?: string // 詳細表示の「更新日時」列に使う
  totalSize?: number // フォルダ内のファイル合計サイズ(バイト)
  manualCount?: number // フォルダ内のファイル数
  adminOnly?: boolean // 管理者だけに見せるフォルダか
}

interface CategoriesData {
  manualCategories: Category[]
}

export const CATEGORIES_QUERY: TypedDocumentNode<CategoriesData> = gql`
  query ManualCategories {
    manualCategories {
      id
      name
      updatedAt
      totalSize
      manualCount
      adminOnly
    }
  }
`

// --- 並び替え(ADMIN専用)。渡した順に並び順を振り直す ---

interface ReorderCategoriesData {
  reorderManualCategories: number
}

interface ReorderCategoriesVars {
  ids: string[]
}

export const REORDER_CATEGORIES_MUTATION: TypedDocumentNode<
  ReorderCategoriesData,
  ReorderCategoriesVars
> = gql`
  mutation ReorderManualCategories($ids: [ID!]!) {
    reorderManualCategories(ids: $ids)
  }
`

// --- カテゴリ作成(ADMIN専用) ---

interface CreateCategoryData {
  createManualCategory: Category
}

interface CreateCategoryVars {
  name: string
  /** 管理者だけに見せるフォルダにするか */
  adminOnly?: boolean
}

export const CREATE_CATEGORY_MUTATION: TypedDocumentNode<
  CreateCategoryData,
  CreateCategoryVars
> = gql`
  mutation CreateManualCategory($name: String!, $adminOnly: Boolean) {
    createManualCategory(name: $name, adminOnly: $adminOnly) {
      id
      name
      adminOnly
    }
  }
`

// --- カテゴリ名の変更(ADMIN専用) ---

interface UpdateCategoryData {
  updateManualCategory: Category
}

interface UpdateCategoryVars {
  id: string
  name: string
  /** 省略すると今の設定のまま(名前の変更だけで公開範囲が動かないように) */
  adminOnly?: boolean
}

export const UPDATE_CATEGORY_MUTATION: TypedDocumentNode<
  UpdateCategoryData,
  UpdateCategoryVars
> = gql`
  mutation UpdateManualCategory(
    $id: ID!
    $name: String!
    $adminOnly: Boolean
  ) {
    updateManualCategory(id: $id, name: $name, adminOnly: $adminOnly) {
      id
      name
      adminOnly
    }
  }
`

// --- カテゴリ削除(ADMIN専用。マニュアルが残っていると失敗する) ---

interface DeleteCategoryData {
  deleteManualCategory: Category
}

interface DeleteCategoryVars {
  id: string
}

export const DELETE_CATEGORY_MUTATION: TypedDocumentNode<
  DeleteCategoryData,
  DeleteCategoryVars
> = gql`
  mutation DeleteManualCategory($id: ID!) {
    deleteManualCategory(id: $id) {
      id
      name
    }
  }
`
