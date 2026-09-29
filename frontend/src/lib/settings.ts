import { useSyncExternalStore } from 'react'

/**
 * アプリ設定(localStorageに保存)。
 * useSyncExternalStoreで購読するので、設定ダイアログでの変更が
 * チャット画面などの利用側に即座に反映される。
 */

/** チャットの送信キー: enter=Enterで送信 / shift-enter=Shift+Enterで送信 */
export type SendKey = 'enter' | 'shift-enter'

/** 配色: system=端末の設定に追随 / light・dark=固定 */
export type ThemeMode = 'system' | 'light' | 'dark'

/**
 * 画面の並び:
 * - single: 1枚のサイドバーに両方(これまでの表示)
 * - chat-left: チャットを左・マニュアルを右の2枚に分ける
 * - chat-right: チャットを右・マニュアルを左
 */
export type LayoutMode = 'single' | 'chat-left' | 'chat-right'

const SEND_KEY_STORAGE = 'manualSearch.settings.sendKey'
const LAYOUT_STORAGE = 'manualSearch.settings.layout'
// index.htmlの起動スクリプトも同じキーを読む(初期表示のちらつき防止)
const THEME_STORAGE = 'manualSearch.settings.theme'
const listeners = new Set<() => void>()

export function getSendKey(): SendKey {
  try {
    return localStorage.getItem(SEND_KEY_STORAGE) === 'shift-enter'
      ? 'shift-enter'
      : 'enter'
  } catch {
    return 'enter'
  }
}

export function setSendKey(value: SendKey) {
  try {
    localStorage.setItem(SEND_KEY_STORAGE, value)
  } catch {
    // ストレージが使えない環境では保存されないだけ(既定値のまま動く)
  }
  listeners.forEach((listener) => listener())
}

export function getLayoutMode(): LayoutMode {
  try {
    const saved = localStorage.getItem(LAYOUT_STORAGE)
    if (saved === 'chat-left' || saved === 'chat-right') return saved
  } catch {
    // 読めなければ従来どおり1枚
  }
  return 'single'
}

export function setLayoutMode(mode: LayoutMode) {
  try {
    localStorage.setItem(LAYOUT_STORAGE, mode)
  } catch {
    // 保存できない環境では今回だけ有効
  }
  listeners.forEach((listener) => listener())
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, getLayoutMode)
}

export function getThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // 読めなければ端末準拠
  }
  return 'system'
}

/** 実際に画面へ配色を反映する(Chakraは<html>の.dark/.lightを見て切り替える) */
export function applyThemeMode(mode: ThemeMode) {
  const isDark =
    mode === 'dark' ||
    (mode === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.classList.toggle('dark', isDark)
  root.classList.toggle('light', !isDark)
}

export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_STORAGE, mode)
  } catch {
    // 保存できない環境では今回だけ有効
  }
  applyThemeMode(mode)
  listeners.forEach((listener) => listener())
}

/**
 * 端末の配色設定の変更を監視する。
 * 「端末準拠」を選んでいるときだけ、OS側の切り替えに追随させる
 */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (getThemeMode() === 'system') applyThemeMode('system')
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactコンポーネントから設定値を購読する */
export function useSendKey(): SendKey {
  return useSyncExternalStore(subscribe, getSendKey)
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode)
}
