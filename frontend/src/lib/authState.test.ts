import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTH_BOOTSTRAP_TIMEOUT_MS,
  isDifferentUser,
  nextAuthPhase,
  type AuthPhase,
} from './authState.ts'

// --- 大17: Supabaseが応答しないと無地のスピナーのまま止まる ---

test('返事が来なければ時間切れにしてログイン画面を出す', () => {
  assert.equal(nextAuthPhase('loading', 'timeout'), 'timeout')
})

test('時間切れのあとに遅れてINITIAL_SESSIONが来たら復帰する', () => {
  // 購読は解除していないので遅れて届く。ここで戻せないと
  // 「入れるのに入れない」状態でログイン画面に固定される
  assert.equal(nextAuthPhase('timeout', 'session'), 'ready')
})

test('返事が来たあとにタイマーが発火してもスピナーへ戻さない', () => {
  assert.equal(nextAuthPhase('ready', 'timeout'), 'ready')
})

test('返事が来たらいつでもready', () => {
  const phases: AuthPhase[] = ['loading', 'ready', 'timeout']
  for (const phase of phases) {
    assert.equal(nextAuthPhase(phase, 'session'), 'ready')
  }
})

test('待ち時間は5〜8秒に収まっている(25秒放置しない)', () => {
  assert.ok(AUTH_BOOTSTRAP_TIMEOUT_MS >= 5000)
  assert.ok(AUTH_BOOTSTRAP_TIMEOUT_MS <= 8000)
})

// --- 大11: 別の人がログインしても前の人のキャッシュが残る ---

test('別の人がサインインしたら別人と判定する', () => {
  assert.equal(isDifferentUser('user-a', 'user-b'), true)
})

test('同じ人の再サインイン・トークン更新では捨てない', () => {
  assert.equal(isDifferentUser('user-a', 'user-a'), false)
})

test('初回の復元(前の人が居ない)では捨てない', () => {
  assert.equal(isDifferentUser(null, 'user-b'), false)
})

test('サインアウトだけの通知(次の人が居ない)では捨てない', () => {
  // ここで捨てると、まだ画面に居る本人の表示まで消えてしまう
  assert.equal(isDifferentUser('user-a', null), false)
})
