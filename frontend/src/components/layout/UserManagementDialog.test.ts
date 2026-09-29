import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// --- 退行: フロントだけ先に上げるとAWSの招待が壊れる ---
//
// 招待のmutationは方式で2本に分かれた(src/graphql/users.ts)。
// どちらを選ぶかの判断は src/graphql/users.test.ts で固定してあるので、
// ここで守るのは**この画面がその選択を通しているか**だけ。
// 直に片方を指すと、Cognito版なら招待が落ち、Supabase版なら
// 仮パスワードが誰にも渡らない(=9/16に誰もログインできない)

const SOURCE = readFileSync(
  new URL('./UserManagementDialog.tsx', import.meta.url),
  'utf8',
)

test('招待のmutationは認証方式で選んでいる', () => {
  assert.match(SOURCE, /inviteUsersMutation\(USE_SUPABASE_AUTH\)/)
})

test('片方のmutationを直に指していない', () => {
  assert.ok(!/INVITE_USERS_MUTATION/.test(SOURCE))
  assert.ok(!/INVITE_USERS_WITH_PASSWORD_MUTATION/.test(SOURCE))
})

test('仮パスワードが返らない方式でも壊れない(省略可として扱う)', () => {
  // Cognito版は temporaryPassword が undefined のまま返る。
  // 真偽で見てから使っているので、一覧に空行が並ぶことはない
  assert.match(SOURCE, /user\.temporaryPassword\s*\n?\s*\?/)
})
