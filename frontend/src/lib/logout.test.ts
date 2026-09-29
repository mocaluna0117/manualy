import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LOGOUT_TIMEOUT_MS,
  LOGOUT_TIMEOUT_REASON,
  logoutDisposition,
  shouldClearCache,
  signOutWithTimeout,
} from './logout.ts'

// --- 大18: ログアウトが効かないのに効いたように見える ---

test('切れたらokで返る', async () => {
  const outcome = await signOutWithTimeout(async () => ({ error: null }))
  assert.deepEqual(outcome, { ok: true, reason: undefined })
})

test('戻り値が無いログアウト(Cognito版)もokで返る', async () => {
  const outcome = await signOutWithTimeout(async () => {})
  assert.equal(outcome.ok, true)
})

test('サーバーが応答しないときは時間切れで失敗にする', async () => {
  // 待ち続けると「ログアウトしたつもり」で席を立たれる
  const never = () => new Promise<void>(() => {})
  const outcome = await signOutWithTimeout(never, 30)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, LOGOUT_TIMEOUT_REASON)
})

test('errorが返ったら理由をそのまま渡す', async () => {
  const outcome = await signOutWithTimeout(async () => ({
    error: new Error('session_not_found'),
  }))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'session_not_found')
})

test('投げられても握りつぶさない', async () => {
  const outcome = await signOutWithTimeout(async () => {
    throw new Error('Failed to fetch')
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'Failed to fetch')
})

test('同期で投げられても失敗として返る', async () => {
  const outcome = await signOutWithTimeout(() => {
    throw new Error('client is null')
  })
  assert.equal(outcome.ok, false)
})

test('先に終わったら待ち時間のタイマーを片付ける', async () => {
  // 片付けないと、押すたびにタブが閉じるまで生きるタイマーが増える
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const created: unknown[] = []
  const cleared: unknown[] = []
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = realSetTimeout(fn, ms)
    created.push(id)
    return id
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((id: unknown) => {
    cleared.push(id)
    realClearTimeout(id as ReturnType<typeof setTimeout>)
  }) as typeof globalThis.clearTimeout
  try {
    await signOutWithTimeout(async () => ({ error: null }), 10_000)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
  assert.equal(created.length, 1)
  assert.deepEqual(cleared, created)
})

test('既定の待ち時間は数秒(利用者が席を立つ前に結果が出る)', () => {
  assert.ok(LOGOUT_TIMEOUT_MS >= 3000)
  assert.ok(LOGOUT_TIMEOUT_MS <= 8000)
})

// --- 退行: 実際は切れているのに「失敗」と出し、キャッシュが残る ---
//
// supabase-jsのlogoutは、404/401/403とセッション欠落**以外**のerrorでは
// removeCurrentSession()を通ってから {error} を返す(auth-jsの_signOut)。
// 通信できないときがまさにこれで、手元のトークンは消えているのに
// ok=false になる。そこで「失敗だからキャッシュは残す」と決めると、
// ログイン画面の裏に前の人の権限と会話一覧が残ってしまう

test('通信に失敗しても、手元のセッションが消えていればこの端末は切れている', async () => {
  let localSession: { access_token: string } | null = { access_token: 'a' }
  const outcome = await signOutWithTimeout(async () => {
    localSession = null // auth-jsの removeCurrentSession() に相当
    return { error: new Error('fetch failed') }
  })
  assert.equal(outcome.ok, false)
  const disposition = logoutDisposition(outcome, localSession === null)
  assert.equal(disposition, 'local-only')
})

test('この端末で切れているなら、キャッシュは必ず捨てる', () => {
  // ここを「切れた(signed-out)ときだけ捨てる」に戻すと、
  // 共用PCで次の人の画面に前の管理者の権限と会話一覧が残る
  assert.equal(shouldClearCache('local-only'), true)
  assert.equal(shouldClearCache('signed-out'), true)
})

test('本当に切れていないときだけキャッシュを残す', () => {
  // 残っているのに捨てると「空のアプリ」になり、ログアウトできたように見える
  assert.equal(shouldClearCache('failed'), false)
})

test('セッションが残ったままのerrorは失敗のまま', async () => {
  const outcome = await signOutWithTimeout(async () => ({
    error: new Error('boom'),
  }))
  assert.equal(logoutDisposition(outcome, false), 'failed')
})

test('時間切れは失敗のまま(手元のセッションも残っている)', async () => {
  const never = () => new Promise<void>(() => {})
  const outcome = await signOutWithTimeout(never, 30)
  assert.equal(logoutDisposition(outcome, false), 'failed')
})

test('サーバーまで通ったときは、素直に切れたとして扱う', async () => {
  const outcome = await signOutWithTimeout(async () => ({ error: null }))
  assert.equal(logoutDisposition(outcome, true), 'signed-out')
})
