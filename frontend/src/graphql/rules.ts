import { gql, type TypedDocumentNode } from '@apollo/client'

/** 管理者がAIに教える分類ルール(ADMIN専用) */
export interface ClassificationRule {
  id: string
  text: string
  createdAt: string
}

interface RulesData {
  classificationRules: ClassificationRule[]
}

export const RULES_QUERY: TypedDocumentNode<RulesData> = gql`
  query ClassificationRules {
    classificationRules {
      id
      text
      createdAt
    }
  }
`

interface CreateRuleData {
  createClassificationRule: ClassificationRule
}
interface CreateRuleVars {
  text: string
}

export const CREATE_RULE_MUTATION: TypedDocumentNode<
  CreateRuleData,
  CreateRuleVars
> = gql`
  mutation CreateClassificationRule($text: String!) {
    createClassificationRule(text: $text) {
      id
      text
      createdAt
    }
  }
`

interface UpdateRuleData {
  updateClassificationRule: ClassificationRule
}
interface UpdateRuleVars {
  id: string
  text: string
}

export const UPDATE_RULE_MUTATION: TypedDocumentNode<
  UpdateRuleData,
  UpdateRuleVars
> = gql`
  mutation UpdateClassificationRule($id: ID!, $text: String!) {
    updateClassificationRule(id: $id, text: $text) {
      id
      text
      createdAt
    }
  }
`

interface DeleteRuleData {
  deleteClassificationRule: { id: string }
}
interface DeleteRuleVars {
  id: string
}

export const DELETE_RULE_MUTATION: TypedDocumentNode<
  DeleteRuleData,
  DeleteRuleVars
> = gql`
  mutation DeleteClassificationRule($id: ID!) {
    deleteClassificationRule(id: $id) {
      id
    }
  }
`
