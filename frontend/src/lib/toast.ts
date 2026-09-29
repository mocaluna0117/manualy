import { createToaster } from '@chakra-ui/react'

/**
 * 画面右下に出る通知。
 *
 * ブラウザ標準の alert は、見た目がアプリから浮くうえに操作を止めてしまう。
 * 通知は読めれば十分で、押して閉じる必要はないのでトーストにする。
 * 「消えたら困る」確認(削除してよいか等)は、これまで通り確認ダイアログを使う。
 */
export const toaster = createToaster({
  placement: 'bottom-end',
  // 画面を見ていない間は時間を止める(戻ってきたときに読み逃さない)
  pauseOnPageIdle: true,
  max: 4,
})

/** 成功。手短に済むので短め */
export function toastSuccess(title: string, description?: string) {
  toaster.create({ type: 'success', title, description, duration: 4000 })
}

/**
 * 失敗。読み落とすと困るので長めに出し、閉じるまで残す選択肢も持たせる。
 * 文言は「何が起きたか」が分かる形で渡すこと
 */
export function toastError(title: string, description?: string) {
  toaster.create({ type: 'error', title, description, duration: 8000 })
}

/** お知らせ。件数の報告など、失敗ではないが目を通してほしいもの */
export function toastInfo(title: string, description?: string) {
  toaster.create({ type: 'info', title, description, duration: 6000 })
}

/**
 * 結果が長いもの(1件ずつの一覧など)。読み切るまで消さない。
 * 自動で消えると読み終わらないため、閉じるボタンで消す
 */
export function toastReport(title: string, description?: string) {
  toaster.create({ type: 'info', title, description, duration: Infinity })
}

/** 例外から画面に出す文言を取り出す(不明なものは定型文にする) */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}
