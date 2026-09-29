import { gql, type TypedDocumentNode } from '@apollo/client'

// 問い合わせの一覧・対応済みの切り替え(ADMIN専用)。
// メールを見落としても画面から追えるようにするための問い合わせ管理

export interface InquiryItem {
  id: string
  userEmail: string | null
  message: string
  /** 添付画像の閲覧用URL(期限付き) */
  imageUrls: string[]
  /** 添付画像が保存期間を過ぎて削除されたか */
  imagesPurged: boolean
  /** 対応済みにした時刻。nullなら未対応 */
  handledAt: string | null
  createdAt: string
}

interface InquiriesData {
  inquiries: InquiryItem[]
}

interface DaysVars {
  /** 何日ぶんを見るか。null/0で全件 */
  days?: number | null
}

export const INQUIRIES_QUERY: TypedDocumentNode<InquiriesData, DaysVars> = gql`
  query Inquiries($days: Int) {
    inquiries(days: $days) {
      id
      userEmail
      message
      imageUrls
      imagesPurged
      handledAt
      createdAt
    }
  }
`

interface CountsData {
  inquiryCounts: { unhandled: number; total: number }
}

export const INQUIRY_COUNTS_QUERY: TypedDocumentNode<CountsData> = gql`
  query InquiryCounts {
    inquiryCounts {
      unhandled
      total
    }
  }
`

interface SetHandledData {
  setInquiryHandled: InquiryItem
}

export const SET_INQUIRY_HANDLED_MUTATION: TypedDocumentNode<
  SetHandledData,
  { id: string; handled: boolean }
> = gql`
  mutation SetInquiryHandled($id: ID!, $handled: Boolean!) {
    setInquiryHandled(id: $id, handled: $handled) {
      id
      handledAt
    }
  }
`
