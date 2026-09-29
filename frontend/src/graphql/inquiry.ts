import { gql, type TypedDocumentNode } from '@apollo/client'

interface SendInquiryData {
  sendInquiry: boolean
}

/** 添える画像1枚分 */
export interface InquiryImageInput {
  base64: string
  /** png / jpeg / webp / gif */
  format: string
}

interface SendInquiryVars {
  message: string
  /** 画面のスクリーンショット(任意・複数可)。メールに添付されて届く */
  images?: InquiryImageInput[]
}

export const SEND_INQUIRY_MUTATION: TypedDocumentNode<
  SendInquiryData,
  SendInquiryVars
> = gql`
  mutation SendInquiry($message: String!, $images: [InquiryImageInput!]) {
    sendInquiry(message: $message, images: $images)
  }
`
