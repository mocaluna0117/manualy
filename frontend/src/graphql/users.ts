import { gql, type TypedDocumentNode } from '@apollo/client'
import type { UserRole } from './me'

// 管理画面(ユーザー管理)用。アカウントの実体は認証基盤、権限はDB
export interface ManagedUser {
  cognitoSub: string
  email: string | null
  role: UserRole
  passwordPending: boolean // 招待直後(まだ一度もログインしていない)
  createdAt: string | null
  /**
   * 発行したばかりの仮パスワード。**招待した直後の応答にしか入らない**
   * (一覧では常にnull)ので、省略可にしてある。
   * Cognito版は招待メールが飛ぶのでnullのまま
   */
  temporaryPassword?: string | null
}

export const USERS_QUERY: TypedDocumentNode<{ users: ManagedUser[] }> = gql`
  query Users {
    users {
      cognitoSub
      email
      role
      passwordPending
      createdAt
    }
  }
`

/** まとめて招待した結果。送れた分と送れなかった分の両方が返る */
export interface InviteResult {
  invited: ManagedUser[]
  failed: { email: string; reason: string }[]
}

/** 招待のmutationの型(方式で中身が変わっても呼び出し側は同じ形で使える) */
export type InviteUsersMutation = TypedDocumentNode<
  { inviteUsers: InviteResult },
  { emails: string[]; role: UserRole }
>

/**
 * Cognito(AWS本番)版の招待。**temporaryPassword を要求しない。**
 *
 * 9/16までAWSが本番で、そちらのスキーマの ManagedUser にこの項目は無い。
 * 無条件に要求すると、フロントだけ先に上げた瞬間に
 * `Cannot query field "temporaryPassword" on type "ManagedUser"` で
 * 招待が丸ごと動かなくなる。環境変数が未設定なら従来どおりに倒す
 */
export const INVITE_USERS_MUTATION: InviteUsersMutation = gql`
  mutation InviteUsers($emails: [String!]!, $role: UserRole) {
    inviteUsers(emails: $emails, role: $role) {
      invited {
        cognitoSub
        email
        role
        passwordPending
        createdAt
      }
      failed {
        email
        reason
      }
    }
  }
`

/**
 * Supabase版の招待。
 *
 * Supabase版は招待メールが飛ばず、仮パスワードはこの応答にしか
 * 入らない。ここで受け取らないと、管理者が本人に渡す文字列が
 * どこにも出ない(=誰もログインできない)
 */
export const INVITE_USERS_WITH_PASSWORD_MUTATION: InviteUsersMutation = gql`
  mutation InviteUsers($emails: [String!]!, $role: UserRole) {
    inviteUsers(emails: $emails, role: $role) {
      invited {
        cognitoSub
        email
        role
        passwordPending
        createdAt
        temporaryPassword
      }
      failed {
        email
        reason
      }
    }
  }
`

/**
 * 認証方式に合う招待のmutationを選ぶ。
 *
 * 判定そのものは呼び出し側(USE_SUPABASE_AUTH)から渡してもらう。
 * ここで lib/auth をimportすると、この定義が import.meta.env と
 * window に依存して `node --test` から触れなくなる
 */
export function inviteUsersMutation(
  useSupabaseAuth: boolean,
): InviteUsersMutation {
  return useSupabaseAuth
    ? INVITE_USERS_WITH_PASSWORD_MUTATION
    : INVITE_USERS_MUTATION
}

export const UPDATE_USER_ROLE_MUTATION: TypedDocumentNode<
  { updateUserRole: ManagedUser },
  { cognitoSub: string; role: UserRole }
> = gql`
  mutation UpdateUserRole($cognitoSub: ID!, $role: UserRole!) {
    updateUserRole(cognitoSub: $cognitoSub, role: $role) {
      cognitoSub
      role
    }
  }
`

export const DELETE_USER_MUTATION: TypedDocumentNode<
  { deleteUser: boolean },
  { cognitoSub: string }
> = gql`
  mutation DeleteUser($cognitoSub: ID!) {
    deleteUser(cognitoSub: $cognitoSub)
  }
`
