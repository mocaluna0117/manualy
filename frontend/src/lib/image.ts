/** 添付できる画像の上限(4MB) */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 受け付ける画像形式。値はサーバーへ渡す形式名 */
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** File → base64文字列(data:プレフィックスを除いた本体) */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',', 2)[1] ?? '')
    }
    reader.onerror = () => reject(new Error('画像を読み込めませんでした'))
    reader.readAsDataURL(file)
  })
}

/**
 * 添付してよい画像かを確かめる。
 * 問題があれば利用者に見せる文言を返す(問題なければnull)
 */
export function checkImage(file: File): string | null {
  if (!(file.type in ALLOWED_IMAGE_TYPES)) {
    return 'PNG / JPEG / WebP / GIF を選んでください'
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return '画像は4MB以下にしてください'
  }
  return null
}

// --- 送る前にブラウザ側で縮める ---
//
// rag側(vision.shrink_for_upload)でも同じことをしているが、それは
// Workers AI のリクエストボディに収めるための最後の砦で、
// **ブラウザ→backend→rag の間には依然として生のまま流れていた。**
// 1枚4MB×4枚=16MB(base64で21MB。backendのJSON上限は24mb)が
// 0.5vCPU/1GBのコンテナにそのまま届く。手元で縮めておけば、
// 遅い回線での待ち時間も同じだけ短くなる。
// 上限を下げて「大きすぎます」と断るより、黙って縮めるほうが手が止まらない

/** 縮めた後の長辺の上限(px)。rag側の MAX_IMAGE_EDGE と同じ値にする */
export const MAX_IMAGE_EDGE = 1600

/** 縮めるときのJPEG品質(canvas.toBlobは0〜1で受ける) */
export const SHRINK_JPEG_QUALITY = 0.85

/**
 * これ以下はそのまま送る。
 * スクリーンショットのPNGを不用意にJPEGへ焼き直すと細い文字がにじむ。
 * rag側の SHRINK_SKIP_BYTES と同じ値(4枚でも生2.8MBに収まる)
 */
export const SHRINK_SKIP_BYTES = 700_000

/**
 * 長辺が maxEdge に収まる寸法。元から小さければそのまま返す。
 * 縦横の比は保つ(潰れた画像を読ませても意味が無い)
 */
export function fitWithinEdge(
  width: number,
  height: number,
  maxEdge: number = MAX_IMAGE_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest <= 0) return { width, height }
  const scale = maxEdge / longest
  return {
    // 0pxのcanvasは描けないので、丸めて0になったら1にする
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** 送る前に縮めるべきか(小さいものは触らない) */
export function shouldShrink(file: { size: number }): boolean {
  return file.size > SHRINK_SKIP_BYTES
}

/** 縮めた後のファイル名。中身がJPEGになるので拡張子も合わせる */
export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '')
  return `${base || 'image'}.jpg`
}

/**
 * 添付画像を、送る前に長辺1600px・JPEG品質85まで落とす。
 *
 * **縮められなければ元のまま返す。** ここで投げると、質問そのものが
 * 送れなくなる。そのまま送っても、rag側がもう一度縮めるので
 * この関数を入れる前と同じ振る舞いに戻るだけで済む
 */
export async function shrinkForUpload(file: File): Promise<File> {
  if (!shouldShrink(file)) return file
  try {
    // 向きはExifにしか入っていないことがある(スマホ写真)。
    // 起こしてから描かないと、横倒しの文字を読ませることになる
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    })
    try {
      const { width, height } = fitWithinEdge(bitmap.width, bitmap.height)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return file
      // 透過は白で埋める。埋めずにJPEGにすると黒地になり、文字が沈む
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(bitmap, 0, 0, width, height)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', SHRINK_JPEG_QUALITY),
      )
      // 縮めたつもりで太ることがある(元が既に小さいJPEGのとき)
      if (!blob || blob.size >= file.size) return file
      return new File([blob], jpegName(file.name), { type: 'image/jpeg' })
    } finally {
      bitmap.close()
    }
  } catch {
    return file
  }
}
