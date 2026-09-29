import { gql, type TypedDocumentNode } from '@apollo/client'

export type UserRole = 'ADMIN' | 'MEMBER'

interface MeData {
  me: {
    id: string
    email: string | null
    role: UserRole
  }
}

export const ME_QUERY: TypedDocumentNode<MeData> = gql`
  query Me {
    me {
      id
      email
      role
    }
  }
`
