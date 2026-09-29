import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// --- 退行: 検索結果からの再取り込みが unhandled rejection になる ---
//
// backendは取り込み中の再実行を BadRequest で弾くようになった。
// 呼び出し側が投げっぱなし(`void ingestManual(...)`)だと、画面には
// 何も出ないまま何も起きない。押した人には「壊れている」ようにしか見えない。
//
// この画面はJSXなので`node --test`では動かせない。ここでは
// **失敗を受け止める書き方になっているか**だけを原文で固定する。
// 見た目ではなく「握りつぶしていないこと」を守るための最低限の網

const SOURCE = readFileSync(
  new URL('./ManualSearchResults.tsx', import.meta.url),
  'utf8',
)

/** `開始` から次の `終わり` の直前までを切り出す */
function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `${start} が見つからない`)
  const to = source.indexOf(end, from)
  assert.notEqual(to, -1, `${start} の後ろに ${end} が見つからない`)
  return source.slice(from, to)
}

test('再取り込みの失敗を受け止めている(投げっぱなしにしない)', () => {
  const callSite = block(SOURCE, 'onIngestManual=', 'onRenameManual=')
  // 呼び出し側で受けるか、useMutationのonErrorで受けるかはどちらでもよい
  const options = block(
    SOURCE,
    'useMutation(INGEST_MANUAL_MUTATION',
    'const [renameManual]',
  )
  assert.ok(
    callSite.includes('.catch(') || options.includes('onError'),
    '再取り込みの失敗がどこにも届いていない(unhandled rejectionになる)',
  )
})

test('受け止めたうえで、理由を画面に出している', () => {
  const callSite = block(SOURCE, 'onIngestManual=', 'onRenameManual=')
  const options = block(
    SOURCE,
    'useMutation(INGEST_MANUAL_MUTATION',
    'const [renameManual]',
  )
  // 握りつぶし(catchして何もしない)も、画面に何も出ない点では同じ
  assert.ok(
    /toastError/.test(callSite) || /toastError/.test(options),
    '受け止めているが画面には何も出していない',
  )
})

test('名前の変更も同じように受け止めている(先に直っていた分を守る)', () => {
  const callSite = block(SOURCE, 'onRenameManual=', 'onTogglePin=')
  assert.match(callSite, /\.catch\(/)
  assert.match(callSite, /toastError/)
})
