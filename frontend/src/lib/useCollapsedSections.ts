import { useState } from 'react'

/** 折りたたみの状態。trueなら閉じている */
export interface CollapsedSections {
  chat: boolean
  manuals: boolean
}

const KEY = 'manualy.sidebar.collapsed'

function read(): CollapsedSections {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) return { chat: false, manuals: false, ...JSON.parse(saved) }
  } catch {
    // 読めなければ既定(両方開いている)
  }
  return { chat: false, manuals: false }
}

/**
 * サイドバーの「チャット履歴」「マニュアル」を閉じているかどうか。
 *
 * 端末に覚えておく。開くたびに畳み直すのは手間なので、
 * 一度閉じたら次に開いたときも閉じたままにする
 */
export function useCollapsedSections(): [
  CollapsedSections,
  (next: CollapsedSections) => void,
] {
  const [collapsed, setCollapsed] = useState<CollapsedSections>(read)

  const update = (next: CollapsedSections) => {
    setCollapsed(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // 保存できなくても、この画面を開いている間は保つ
    }
  }

  return [collapsed, update]
}
