import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// --- 退行: ログアウトが「実際は切れているのに失敗」と出し、キャッシュが残る ---
//
// 判断そのものは lib/logout(logoutDisposition / shouldClearCache)に出して
// あり、そちらは src/lib/logout.test.ts で固定してある。ここで守るのは
// **サイドバーがその判断を使っているか**と、**押した手応えがあるか**。
// JSXなので`node --test`では動かせないぶん、原文で最低限を止める

const SOURCE = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')

/** `開始` から次の `終わり` の直前までを切り出す */
function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `${start} が見つからない`)
  const to = source.indexOf(end, from)
  assert.notEqual(to, -1, `${start} の後ろに ${end} が見つからない`)
  return source.slice(from, to)
}

const HANDLE_LOGOUT = block(
  SOURCE,
  'const handleLogout = async () => {',
  'const [deleteConversation]',
)

test('errorが返っただけで失敗と決めつけず、手元のセッションを見ている', () => {
  // supabase-jsは通信に失敗しても手元のセッションを消してからerrorを返す。
  // ok=falseで打ち切ると、切れているのに「できませんでした」と出たうえ、
  // Apolloのキャッシュ(前の人の権限・会話一覧)がログイン画面の裏に残る
  assert.match(HANDLE_LOGOUT, /currentSupabaseSession\(\)/)
  assert.match(HANDLE_LOGOUT, /logoutDisposition\(/)
})

test('この端末で切れているならキャッシュを捨てる判断を通している', () => {
  assert.match(HANDLE_LOGOUT, /shouldClearCache\(/)
  assert.match(HANDLE_LOGOUT, /clearStore\(\)/)
})

test('本当に切れていないときだけ失敗として出す', () => {
  assert.match(HANDLE_LOGOUT, /'failed'/)
  assert.match(HANDLE_LOGOUT, /toastError\('ログアウトできませんでした'/)
})

test('切れているときは失敗ではなくお知らせとして出す', () => {
  assert.match(HANDLE_LOGOUT, /toastInfo\(/)
})

test('返事を待つ間、ログアウトのボタンは押せない', () => {
  // 返事は最大5秒待つ。無反応のまま連打されると、応答しないsignOutが
  // 積み上がり、後から来た結果で文言が上書きされる
  const button = block(SOURCE, 'aria-label="ログアウト"', '</Tooltip>')
  assert.match(button, /loading=\{loggingOut\}/)
  assert.match(button, /disabled=\{loggingOut\}/)
})

test('Cognito(AWS本番)の経路は今まで通り、外部のログアウトへ飛ばす', () => {
  // 環境変数が未設定なら従来どおりであること
  assert.match(HANDLE_LOGOUT, /signOutRedirect\(\)/)
})

// --- 退行: サイドバーの見出しがスクロールで消える / 貼り付いても下が透ける ---
//
// 見た目の話なので原文でしか止められない(このプロジェクトのフロントは
// JSXを描画するテスト基盤が無い)。実際に貼り付くか・重ならないかは
// ブラウザで見るしかないが、**壊れ方が決まっている3点**はここで止める。

/** チャット履歴の見出し(sticky の箱ごと) */
const CHAT_HEADER = block(
  SOURCE,
  '{/* 履歴が増えても、いま何の一覧を見ているか分かるよう',
  '{chatOpen && loadingChats',
)

/** マニュアルの見出し(sticky の HStack ごと) */
const MANUALS_HEADER = block(
  SOURCE,
  '{/* カテゴリ別マニュアル(DBから取得)',
  '<HStack gap={0} minW={0}>',
)

test('両方の見出しが上端に貼り付く', () => {
  for (const [name, header] of [
    ['チャット履歴', CHAT_HEADER],
    ['マニュアル', MANUALS_HEADER],
  ] as const) {
    assert.match(header, /position="sticky"/, `${name}の見出しが sticky でない`)
    assert.match(header, /top=\{0\}/, `${name}の見出しに top が無い`)
    // 背景が無いと、貼り付いた見出しの下を行が素通りして透ける
    assert.match(header, /bg="bg\.subtle"/, `${name}の見出しに背景が無い`)
  }
})

test('見出しの下余白は margin ではなく padding', () => {
  // margin は背景の外側なので塗られない。mb で余白を取ると、貼り付いている間
  // その隙間から下の行が透けて流れる(2026-09-12 に実際に直した不具合)
  for (const [name, header] of [
    ['チャット履歴', CHAT_HEADER],
    ['マニュアル', MANUALS_HEADER],
  ] as const) {
    assert.doesNotMatch(header, /\bmb=/, `${name}の見出しに mb が戻っている`)
    assert.match(header, /\bpb=/, `${name}の見出しに pb が無い`)
  }
})

test('見出しとリストがセクションごとの箱に入っている', () => {
  // sticky の効く範囲は「一番近いブロックの親」。Fragment(<>)に戻すと
  // 範囲がスクロール領域全体になり、セクションを抜けても見出しが居座って
  // 次の見出しと上端で重なる
  assert.match(SOURCE, /\{showChat && \(\s*<Box>/)
  assert.match(SOURCE, /\{showManuals && \(\s*<Box>/)
})
