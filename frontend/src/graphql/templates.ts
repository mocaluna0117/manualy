import { gql, type TypedDocumentNode } from '@apollo/client'

/** チャット入力欄に挿し込める定型文(管理者が編集できる) */
export interface PromptTemplate {
  id: string
  title: string
  body: string
}

interface TemplatesData {
  promptTemplates: PromptTemplate[]
}

export const TEMPLATES_QUERY: TypedDocumentNode<TemplatesData> = gql`
  query PromptTemplates {
    promptTemplates {
      id
      title
      body
    }
  }
`

// --- 以下はADMIN専用 ---

interface CreateTemplateData {
  createPromptTemplate: PromptTemplate
}
interface CreateTemplateVars {
  title: string
  body: string
}

export const CREATE_TEMPLATE_MUTATION: TypedDocumentNode<
  CreateTemplateData,
  CreateTemplateVars
> = gql`
  mutation CreatePromptTemplate($title: String!, $body: String!) {
    createPromptTemplate(title: $title, body: $body) {
      id
      title
      body
    }
  }
`

interface UpdateTemplateData {
  updatePromptTemplate: PromptTemplate
}
interface UpdateTemplateVars {
  id: string
  title: string
  body: string
}

export const UPDATE_TEMPLATE_MUTATION: TypedDocumentNode<
  UpdateTemplateData,
  UpdateTemplateVars
> = gql`
  mutation UpdatePromptTemplate($id: ID!, $title: String!, $body: String!) {
    updatePromptTemplate(id: $id, title: $title, body: $body) {
      id
      title
      body
    }
  }
`

interface DeleteTemplateData {
  deletePromptTemplate: { id: string }
}
interface DeleteTemplateVars {
  id: string
}

export const DELETE_TEMPLATE_MUTATION: TypedDocumentNode<
  DeleteTemplateData,
  DeleteTemplateVars
> = gql`
  mutation DeletePromptTemplate($id: ID!) {
    deletePromptTemplate(id: $id) {
      id
    }
  }
`

interface ReorderTemplatesData {
  reorderPromptTemplates: number
}
interface ReorderTemplatesVars {
  ids: string[]
}

export const REORDER_TEMPLATES_MUTATION: TypedDocumentNode<
  ReorderTemplatesData,
  ReorderTemplatesVars
> = gql`
  mutation ReorderPromptTemplates($ids: [ID!]!) {
    reorderPromptTemplates(ids: $ids)
  }
`
