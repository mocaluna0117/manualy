import type { Manual } from '../graphql/manuals'

/**
 * 一覧の「更新日」に出す日時を決める。
 *
 * 出したいのは元ファイル自体の最終更新日(手元のWindowsやBoxで見えている日付)。
 * ただしこの項目より前に登録されたマニュアルには入っていないので、
 * その場合はこのアプリに登録した日で代用する。
 * DBのupdatedAtは使わない。名前変更や再分類でも動いてしまい、
 * 資料自体の新しさとは一致しないため。
 */
export function updatedDateOf(manual: Manual): {
  date: string | null
  /** 元ファイルの日付ではなく登録日で代用しているか */
  isFallback: boolean
} {
  if (manual.fileLastModified) {
    return { date: manual.fileLastModified, isFallback: false }
  }
  return { date: manual.createdAt ?? null, isFallback: true }
}
