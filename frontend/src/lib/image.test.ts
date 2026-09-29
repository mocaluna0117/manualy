import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  SHRINK_JPEG_QUALITY,
  SHRINK_SKIP_BYTES,
  fitWithinEdge,
  jpegName,
  shouldShrink,
} from './image.ts'

// --- 領域間の隙間: 添付画像が生のままbackendとragへ流れる ---
//
// canvasは`node --test`では動かせないので、縮めるかどうか・
// どの寸法にするかの判断だけをここで固定する。
// (実際に描くところは shrinkForUpload)

test('スマホ写真は長辺1600pxまで落ちる(縦横の比はそのまま)', () => {
  assert.deepEqual(fitWithinEdge(4032, 3024), { width: 1600, height: 1200 })
})

test('縦長でも長辺で合わせる', () => {
  assert.deepEqual(fitWithinEdge(3024, 4032), { width: 1200, height: 1600 })
})

test('正方形は長辺そのもの', () => {
  assert.deepEqual(fitWithinEdge(3000, 3000), { width: 1600, height: 1600 })
})

test('もともと小さい画像は触らない', () => {
  assert.deepEqual(fitWithinEdge(800, 600), { width: 800, height: 600 })
  assert.deepEqual(fitWithinEdge(1600, 900), { width: 1600, height: 900 })
})

test('極端に細長くても0pxにしない(0pxのcanvasは描けない)', () => {
  const size = fitWithinEdge(8000, 3)
  assert.equal(size.width, 1600)
  assert.ok(size.height >= 1)
})

test('上限いっぱい(4MB)の添付は必ず縮める対象になる', () => {
  // ここが漏れると、そのまま16MB(base64で21MB)が流れる
  assert.equal(shouldShrink({ size: MAX_IMAGE_BYTES }), true)
})

test('小さいスクリーンショットは焼き直さない(細い文字がにじむ)', () => {
  assert.equal(shouldShrink({ size: SHRINK_SKIP_BYTES }), false)
  assert.equal(shouldShrink({ size: SHRINK_SKIP_BYTES + 1 }), true)
  assert.equal(shouldShrink({ size: 0 }), false)
})

test('縮めない大きさを4枚集めても、backendのJSON上限(24mb)に余裕がある', () => {
  const MAX_IMAGES = 4 // ChatHomeの枚数上限
  const BACKEND_JSON_LIMIT = 24 * 1024 * 1024 // backend/src/main.ts の json({limit})
  const base64 = (bytes: number) => Math.ceil(bytes / 3) * 4
  // 縮めた後(=最悪でもここまで)
  assert.ok(base64(SHRINK_SKIP_BYTES * MAX_IMAGES) < BACKEND_JSON_LIMIT / 4)
  // 縮める前は上限のすぐ手前まで積み上がっていた
  assert.ok(base64(MAX_IMAGE_BYTES * MAX_IMAGES) > BACKEND_JSON_LIMIT * 0.8)
})

test('縮める基準はrag側(vision.py)と同じ値', () => {
  // 片方だけ変えると、フロントで縮めたのにrag側でもう一度焼き直される
  assert.equal(MAX_IMAGE_EDGE, 1600)
  assert.equal(SHRINK_JPEG_QUALITY, 0.85)
  assert.equal(SHRINK_SKIP_BYTES, 700_000)
})

test('縮めた後のファイル名は中身(JPEG)に合わせる', () => {
  assert.equal(jpegName('IMG_0001.HEIC'), 'IMG_0001.jpg')
  assert.equal(jpegName('画面.png'), '画面.jpg')
  assert.equal(jpegName('no-extension'), 'no-extension.jpg')
  assert.equal(jpegName(''), 'image.jpg')
})
