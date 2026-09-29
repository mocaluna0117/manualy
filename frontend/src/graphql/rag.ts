import { gql, type TypedDocumentNode } from '@apollo/client'

export interface RagCitation {
  manualId: string
  title: string
  snippet: string
  pageNumber: number | null
}

interface RagSearchData {
  ragSearch: {
    answer: string
    citations: RagCitation[]
  }
}

interface RagSearchVars {
  question: string
}

export const RAG_SEARCH_QUERY: TypedDocumentNode<RagSearchData, RagSearchVars> =
  gql`
    query RagSearch($question: String!) {
      ragSearch(question: $question) {
        answer
        citations {
          manualId
          title
          snippet
          pageNumber
        }
      }
    }
  `
