import { useState } from 'react'

/** 一覧の表示形式と並び順。画面をまたいで同じ設定を使うのでここに置く */
export type ViewMode = 'details' | 'icons'

export type SortKey = 'name' | 'type' | 'updatedAt' | 'size'

const VIEW_MODE_KEY = 'manualSearch.explorerViewMode'
const NAME_WIDTH_KEY = 'manualSearch.explorerNameWidth'

/** 名前の列を広げられる範囲(px)。Windowsのエクスプローラーと同じ操作感 */
export const NAME_WIDTH_MIN = 160
export const NAME_WIDTH_MAX = 1600


/** 表示形式をlocalStorageに保存して共有する(一覧をどこで開いても同じ形式) */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === 'icons'
        ? 'icons'
        : 'details'
    } catch {
      return 'details'
    }
  })
  const change = (mode: ViewMode) => {
    setViewMode(mode)
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode)
    } catch {
      // 保存できない環境では今回だけ有効
    }
  }
  return [viewMode, change]
}

/**
 * 詳細表示の「名前」列の幅(px)。nullなら余った幅いっぱいに広げる(既定)。
 *
 * 既定のままだと長い題名が「...」で切れるため、見出しの境目をドラッグして
 * 広げられるようにする。幅を決めたときは列の合計が画面より広くなりうるので、
 * 一覧を横スクロールできるようにしてある(エクスプローラーと同じ)。
 */
export function useNameColumnWidth(): [
  number | null,
  (width: number | null, persist?: boolean) => void,
] {
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(NAME_WIDTH_KEY)
      if (!raw) return null
      const n = Number(raw)
      if (!Number.isFinite(n)) return null
      return Math.min(NAME_WIDTH_MAX, Math.max(NAME_WIDTH_MIN, n))
    } catch {
      return null
    }
  })
  // persist=false は「今の見た目だけ変える」。ドラッグ中は毎フレーム呼ばれるので、
  // その都度localStorageに書くと無駄が大きい。離したときにだけ保存する
  const change = (next: number | null, persist = true) => {
    setWidth(next)
    if (!persist) return
    try {
      if (next === null) localStorage.removeItem(NAME_WIDTH_KEY)
      else localStorage.setItem(NAME_WIDTH_KEY, String(next))
    } catch {
      // 保存できない環境では今回だけ有効
    }
  }
  return [width, change]
}

/** 「2026/08/11 19:59」形式(Windowsの日付列と同じ見た目) */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

