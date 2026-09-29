import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// --- 領域間の隙間: 添付画像が生のままbackendとragへ流れる ---
//
// rag側で長辺1600px・品質85に落とすようにしたが、それは
// Workers AI へ投げる直前の話で、**ブラウザ→backend→ragの間は
// 生のまま**だった。1枚4MB×4枚=16MB(base64で21MB)が
// 0.5vCPU/1GBのコンテナに届く。
//
// 送る直前の組み立てはJSXの中なので`node --test`では動かせない。
// ここでは「生のFileをそのままbase64にしていないか」だけを原文で固定する
// (縮める判断そのものは src/lib/image.test.ts)

const SOURCE = readFileSync(new URL('./ChatHome.tsx', import.meta.url), 'utf8')

/** `開始` から次の `終わり` の直前までを切り出す */
function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `${start} が見つからない`)
  const to = source.indexOf(end, from)
  assert.notEqual(to, -1, `${start} の後ろに ${end} が見つからない`)
  return source.slice(from, to)
}

test('質問に添える画像は、送る前に縮めてからbase64にしている', () => {
  const payload = block(SOURCE, 'images: await Promise.all(', 'signal:')
  assert.match(payload, /shrinkForUpload/)
  assert.ok(
    payload.indexOf('shrinkForUpload') < payload.indexOf('fileToBase64'),
    '縮める前にbase64にしている(縮めた意味が無い)',
  )
})

test('元のFileをそのままbase64にしていない', () => {
  // ここが `fileToBase64(i.file)` に戻ると、縮めた結果を捨てて
  // 生の16MBが流れる
  const payload = block(SOURCE, 'images: await Promise.all(', 'signal:')
  assert.ok(!/fileToBase64\(i\.file\)/.test(payload))
})

test('サーバーへ渡す形式名も、縮めた後の中身に合わせている', () => {
  // 縮めるとJPEGになる。元のtypeを渡すと「pngだと言ってJPEGを送る」ことになる
  const payload = block(SOURCE, 'images: await Promise.all(', 'signal:')
  assert.ok(!/ALLOWED_IMAGE_TYPES\[i\.file\.type\]/.test(payload))
})
