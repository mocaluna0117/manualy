import { createContext, useContext } from 'react'

interface ManualViewerContextValue {
  /** どの画面からでもこれを呼ぶと、アプリ内モーダルでPDFが開く(pageで特定ページを直接表示) */
  openManual: (id: string, title: string, page?: number | null) => void
}

export const ManualViewerContext = createContext<ManualViewerContextValue | null>(null)

export function useManualViewer() {
  const ctx = useContext(ManualViewerContext)
  if (!ctx) {
    throw new Error('useManualViewerはManualViewerProviderの内側で使うこと')
  }
  return ctx
}

