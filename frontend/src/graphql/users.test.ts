import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSchema, print, validate } from 'graphql'
import type {
  FieldNode,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql'
import {
  INVITE_USERS_MUTATION,
  INVITE_USERS_WITH_PASSWORD_MUTATION,
  USERS_QUERY,
  inviteUsersMutation,
  type ManagedUser,
} from './users.ts'

/** 選択集合から、そのフィールドの中身を取り出す */
function selectionOf(
  selectionSet: SelectionSetNode | undefined,
  name: string,
): SelectionSetNode | undefined {
  const field = selectionSet?.selections.find(
    (s): s is FieldNode => s.kind === 'Field' && s.name.value === name,
  )
  return field?.selectionSet
}

/** 選んでいるフィールド名の一覧 */
function fieldNames(selectionSet: SelectionSetNode | undefined): string[] {
  return (selectionSet?.selections ?? [])
    .filter((s): s is FieldNode => s.kind === 'Field')
    .map((s) => s.name.value)
}

function operation(document: { definitions: readonly unknown[] }) {
  return document.definitions.find(
    (d): d is OperationDefinitionNode =>
      (d as OperationDefinitionNode).kind === 'OperationDefinition',
  )
}

// --- 大3: 仮パスワードが画面に出ない ---

test('Supabase版の招待の応答で仮パスワードを受け取っている', () => {
  // Supabase版は招待メールが飛ばず、仮パスワードはこの応答にしか入らない。
  // ここを落とすと、9/16に招待した8名が誰もログインできない
  const invited = selectionOf(
    selectionOf(
      operation(INVITE_USERS_WITH_PASSWORD_MUTATION)?.selectionSet,
      'inviteUsers',
    ),
    'invited',
  )
  assert.ok(invited, 'inviteUsers.invited の選択集合が見つからない')
  assert.ok(fieldNames(invited).includes('temporaryPassword'))
})

test('招待の応答から、宛先と対にして渡せる', () => {
  // メールアドレスが無いと、どの仮パスワードを誰に渡すのか分からない。
  // どちらの方式でも一覧の表示に使うので、2本とも確かめる
  for (const document of [
    INVITE_USERS_MUTATION,
    INVITE_USERS_WITH_PASSWORD_MUTATION,
  ]) {
    const invited = selectionOf(
      selectionOf(operation(document)?.selectionSet, 'inviteUsers'),
      'invited',
    )
    assert.ok(fieldNames(invited).includes('email'))
  }
})

test('送れなかった宛先の理由も受け取っている', () => {
  for (const document of [
    INVITE_USERS_MUTATION,
    INVITE_USERS_WITH_PASSWORD_MUTATION,
  ]) {
    const failed = selectionOf(
      selectionOf(operation(document)?.selectionSet, 'inviteUsers'),
      'failed',
    )
    assert.deepEqual(fieldNames(failed).sort(), ['email', 'reason'])
  }
})

test('一覧では仮パスワードを要求しない', () => {
  // サーバーは一覧では常にnullを返す。取りに行っても意味がないうえ、
  // 「一覧に出るはず」という誤解のもとになる
  const users = selectionOf(operation(USERS_QUERY)?.selectionSet, 'users')
  assert.ok(!fieldNames(users).includes('temporaryPassword'))
})

test('仮パスワードは省略可(一覧の型と共用しているため)', () => {
  const listed: ManagedUser = {
    cognitoSub: 'sub-1',
    email: 'a@example.com',
    role: 'MEMBER',
    passwordPending: true,
    createdAt: null,
  }
  assert.equal(listed.temporaryPassword, undefined)
})

// --- 退行: フロントだけ先に上げるとAWSの招待が壊れる ---
//
// 9/16までAWSが本番。そちらの ManagedUser に temporaryPassword は無いので、
// 無条件に要求すると招待が丸ごと落ちる。スキーマそのものを写して確かめる
// (「フィールド名が入っているか」だけだと、名前を変えられたときに気づけない)

/** 切り替え前のAWS本番のスキーマ(backend/src/schema.gql の該当部分) */
const AWS_SCHEMA = buildSchema(`
  scalar DateTime
  enum UserRole { ADMIN MEMBER }
  type ManagedUser {
    cognitoSub: ID!
    email: String
    role: UserRole!
    passwordPending: Boolean!
    createdAt: DateTime
  }
  type InviteFailure { email: String! reason: String! }
  type InviteResult { invited: [ManagedUser!]! failed: [InviteFailure!]! }
  type Query { users: [ManagedUser!]! }
  type Mutation {
    inviteUsers(emails: [String!]!, role: UserRole): InviteResult!
  }
`)

test('既定(Cognito)の招待は、AWS本番のスキーマでそのまま通る', () => {
  // これが落ちると、切り替え日より前にフロントだけ上げた瞬間に
  // Cannot query field "temporaryPassword" で招待が動かなくなる
  const errors = validate(AWS_SCHEMA, INVITE_USERS_MUTATION)
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  )
})

test('一覧の取得も、AWS本番のスキーマでそのまま通る', () => {
  assert.deepEqual(
    validate(AWS_SCHEMA, USERS_QUERY).map((e) => e.message),
    [],
  )
})

test('Supabase版はAWS本番のスキーマでは通らない(だから方式で分ける)', () => {
  // 上のテストが「スキーマを甘くしただけ」で通っていないことの裏取り
  const errors = validate(AWS_SCHEMA, INVITE_USERS_WITH_PASSWORD_MUTATION)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /temporaryPassword/)
})

test('環境変数が未設定(false)なら仮パスワードを要求しない方を選ぶ', () => {
  assert.equal(inviteUsersMutation(false), INVITE_USERS_MUTATION)
  assert.ok(!print(inviteUsersMutation(false)).includes('temporaryPassword'))
})

test('Supabase方式でビルドしたときだけ仮パスワードを要求する', () => {
  assert.equal(inviteUsersMutation(true), INVITE_USERS_WITH_PASSWORD_MUTATION)
  assert.ok(print(inviteUsersMutation(true)).includes('temporaryPassword'))
})

test('2本のmutationは操作名が同じ(サーバー側の解決先は1つ)', () => {
  // 名前がずれると、片方だけ通ってもう片方が「そんな操作は無い」になる
  assert.equal(
    operation(INVITE_USERS_MUTATION)?.name?.value,
    operation(INVITE_USERS_WITH_PASSWORD_MUTATION)?.name?.value,
  )
})
