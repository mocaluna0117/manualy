/**
 * 問い合わせの書きかけ(本文と添付画像)の置き場。
 *
 * なぜコンポーネントの外に置くのか:
 * 問い合わせのダイアログはサイドバーの中に置かれているため、
 * サイドバーを閉じるとアンマウントされ、useStateで持っていた内容は消える。
 * 「画面のこの状態を見せたい」と書き始めて元の画面を確認しに戻る、という
 * 使い方が普通なので、そこで消えると書き直しと撮り直しからやり直しになる。
 *
 * リロードでは消えてよい(そういう取り決め)ので、localStorageではなく
 * モジュールの変数に置く。File自体を保存する手段が無いという事情もある。
 */

export interface DraftImage {
  file: File
  /** プレビュー用のURL(URL.createObjectURLで作ったもの) */
  url: string
}

export interface InquiryDraft {
  message: string
  images: DraftImage[]
}

let draft: InquiryDraft = { message: '', images: [] }

export function getInquiryDraft(): InquiryDraft {
  return draft
}

export function saveInquiryDraft(next: InquiryDraft): void {
  draft = next
}

// 空にするのは呼び出し側(送信できたときにsetMessage('')とclearImages())。
// URLの開放もそちらで行うため、ここには片付けの処理を置かない
