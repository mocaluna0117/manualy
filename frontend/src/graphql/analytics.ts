import { gql, type TypedDocumentNode } from '@apollo/client'

/** 利用状況の集計(すべてADMIN専用)。誰が質問したかは扱わない */

export interface AnalyticsSummary {
  questionCount: number
  answeredCount: number
  unansweredCount: number
  /** 可否を判定できない回答の合計(下の4つの合計) */
  unknownCount: number
  /** 数える意味が無い回答(聞き返し・管理操作・検索対象ゼロ) */
  outOfScopeCount: number
  /** 回答文の生成に失敗した回答 */
  failedCount: number
  /** 通常の回答なのにAIが根拠を申告せず、可否を判定できなかった回答 */
  unreportedCount: number
  /** 結末を記録し始める前に保存されたデータ */
  notRecordedCount: number
  /** 人が👍を押した数 */
  ratedGoodCount: number
  /** 人が👎を押した数 */
  ratedBadCount: number
  neverCitedManualCount: number
}

interface SummaryData {
  analyticsSummary: AnalyticsSummary
}

interface DaysVars {
  /** 集計期間(日)。null/0で全期間 */
  days?: number | null
}

export const ANALYTICS_SUMMARY_QUERY: TypedDocumentNode<
  SummaryData,
  DaysVars
> = gql`
  query AnalyticsSummary($days: Int) {
    analyticsSummary(days: $days) {
      questionCount
      answeredCount
      unansweredCount
      unknownCount
      outOfScopeCount
      failedCount
      unreportedCount
      notRecordedCount
      ratedGoodCount
      ratedBadCount
      neverCitedManualCount
    }
  }
`

export interface UnansweredQuestion {
  id: string
  question: string
  answer: string
  askedAt: string
  /** 人が👎を押したもの(AIの判定ではなく利用者の判断で拾われた) */
  ratedBad: boolean
  /** 👎のときに選ばれた理由(任意) */
  feedbackReason: string | null
}

interface UnansweredData {
  unansweredQuestions: UnansweredQuestion[]
}

export const UNANSWERED_QUESTIONS_QUERY: TypedDocumentNode<
  UnansweredData,
  DaysVars
> = gql`
  query UnansweredQuestions($days: Int) {
    unansweredQuestions(days: $days) {
      id
      question
      answer
      askedAt
      ratedBad
      feedbackReason
    }
  }
`

export interface ManualUsage {
  manualId: string
  title: string
  categoryName: string | null
  citedCount: number
  lastCitedAt: string | null
}

interface ManualUsageData {
  manualUsage: ManualUsage[]
}

export const MANUAL_USAGE_QUERY: TypedDocumentNode<ManualUsageData, DaysVars> =
  gql`
    query ManualUsage($days: Int) {
      manualUsage(days: $days) {
        manualId
        title
        categoryName
        citedCount
        lastCitedAt
      }
    }
  `

export interface QuestionTheme {
  theme: string
  count: number
  examples: string[]
}

interface QuestionThemesData {
  questionThemes: QuestionTheme[]
}

// AIを呼ぶので、画面のボタンを押したときだけ実行する
export const QUESTION_THEMES_QUERY: TypedDocumentNode<
  QuestionThemesData,
  DaysVars
> = gql`
  query QuestionThemes($days: Int) {
    questionThemes(days: $days) {
      theme
      count
      examples
    }
  }
`

// --- 答えられなかった質問からマニュアルの下書きを作る(ADMIN専用) ---

export interface ManualDraft {
  /** Markdownの本文 */
  draft: string
  /** 下書きの材料にした既存マニュアル */
  sources: { manualId: string; title: string; pageNumber: number | null }[]
}

interface DraftManualData {
  draftManual: ManualDraft
}

interface DraftManualVars {
  question: string
}

export const DRAFT_MANUAL_MUTATION: TypedDocumentNode<
  DraftManualData,
  DraftManualVars
> = gql`
  mutation DraftManual($question: String!) {
    draftManual(question: $question) {
      draft
      sources {
        manualId
        title
        pageNumber
      }
    }
  }
`
