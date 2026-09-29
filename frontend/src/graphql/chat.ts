import { gql, type TypedDocumentNode } from '@apollo/client'
import type { RagCitation } from './rag'

export type MessageRole = 'USER' | 'ASSISTANT'

/** 回答への評価。未評価はnull */
export type MessageFeedback = 'GOOD' | 'BAD'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  citations: RagCitation[]
  options: string[] // 絞り込み質問の選択肢(ボタン表示)
  imageUrls: string[] // 質問に添えた画像(署名付きURL。添付が無ければ空)
  feedback: MessageFeedback | null
  feedbackReason: string | null // 👎のときに選ばれた理由(任意)
  createdAt: string // 発言時刻(吹き出しの下に表示)
}

export interface Conversation {
  id: string
  title: string
}

// --- 履歴一覧(サイドバー) ---

interface ConversationsData {
  conversations: Conversation[]
}

export const CONVERSATIONS_QUERY: TypedDocumentNode<ConversationsData> = gql`
  query Conversations {
    conversations {
      id
      title
    }
  }
`

// --- 1つの会話とそのメッセージ ---

interface ConversationData {
  conversation: Conversation & { messages: ChatMessage[] }
}

interface ConversationVars {
  id: string
}

export const CONVERSATION_QUERY: TypedDocumentNode<
  ConversationData,
  ConversationVars
> = gql`
  query Conversation($id: ID!) {
    conversation(id: $id) {
      id
      title
      messages {
        id
        role
        content
        citations {
          manualId
          title
          snippet
          pageNumber
        }
        options
        imageUrls
        feedback
        feedbackReason
        createdAt
      }
    }
  }
`

// --- 質問する ---

interface AskData {
  askQuestion: {
    conversationId: string
    message: ChatMessage
  }
}

export interface ChatImageInput {
  base64: string
  format: string
}

interface AskVars {
  question: string
  conversationId?: string
  images?: ChatImageInput[]
}

export const ASK_MUTATION: TypedDocumentNode<AskData, AskVars> = gql`
  mutation AskQuestion(
    $question: String!
    $conversationId: ID
    $images: [ChatImageInput!]
  ) {
    askQuestion(
      question: $question
      conversationId: $conversationId
      images: $images
    ) {
      conversationId
      message {
        id
        role
        content
        citations {
          manualId
          title
          snippet
          pageNumber
        }
        options
        imageUrls
        feedback
        feedbackReason
        createdAt
      }
    }
  }
`

// --- 会話の名前変更 ---

interface RenameConversationData {
  renameConversation: Conversation
}

interface RenameConversationVars {
  id: string
  title: string
}

export const RENAME_CONVERSATION_MUTATION: TypedDocumentNode<
  RenameConversationData,
  RenameConversationVars
> = gql`
  mutation RenameConversation($id: ID!, $title: String!) {
    renameConversation(id: $id, title: $title) {
      id
      title
    }
  }
`

// --- 会話の削除 ---

interface DeleteConversationData {
  deleteConversation: Conversation
}

interface DeleteConversationVars {
  id: string
}

export const DELETE_CONVERSATION_MUTATION: TypedDocumentNode<
  DeleteConversationData,
  DeleteConversationVars
> = gql`
  mutation DeleteConversation($id: ID!) {
    deleteConversation(id: $id) {
      id
      title
    }
  }
`

// --- 回答への評価(👍/👎) ---

interface RateAnswerData {
  rateAnswer: ChatMessage
}

interface RateAnswerVars {
  messageId: string
  /** nullを渡すと評価を取り消す(同じボタンをもう一度押したとき) */
  feedback?: MessageFeedback | null
  /** 👎のときだけ送る理由(任意) */
  reason?: string | null
}

export const RATE_ANSWER_MUTATION: TypedDocumentNode<
  RateAnswerData,
  RateAnswerVars
> = gql`
  mutation RateAnswer($messageId: ID!, $feedback: MessageFeedback, $reason: String) {
    rateAnswer(messageId: $messageId, feedback: $feedback, reason: $reason) {
      id
      feedback
      feedbackReason
    }
  }
`
