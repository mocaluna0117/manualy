import { useApolloClient } from '@apollo/client/react'
import { useState } from 'react'
import {
  MANUAL_DOWNLOAD_URLS_QUERY,
  type ManualDownloadTarget,
} from '../../graphql/manuals'
import { errorMessage, toastError, toastInfo } from '../../lib/toast'

/**
 * マニュアルをまとめてダウンロードする。
 *
 * サーバーで固めるとALBのタイムアウトやメモリを気にする必要があるので、
 * 署名付きURLだけをまとめて受け取り、ZIP化はブラウザで行う。
 * 1件のときはZIPにせずPDFのまま落とす(その方が親切なため)
 */
export function useBulkDownload() {
  const client = useApolloClient()
  // 進行状況(件数)。nullなら実行していない
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  )

  /** 同じファイル名が複数あってもZIP内で上書きされないようにする */
  const uniqueName = (used: Set<string>, name: string) => {
    if (!used.has(name)) {
      used.add(name)
      return name
    }
    const dot = name.lastIndexOf('.')
    const base = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 2; ; i++) {
      const candidate = `${base} (${i})${ext}`
      if (!used.has(candidate)) {
        used.add(candidate)
        return candidate
      }
    }
  }

  const saveBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    // 少し待ってから解放する(即座に消すとダウンロードが始まらない環境がある)
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  /**
   * @param items ダウンロードする対象。folderを指定するとZIP内で
   *              そのフォルダにまとめる(フォルダ選択時の階層を再現する)
   * @param zipName ZIPのファイル名(拡張子なし)
   */
  const download = async (
    items: { id: string; folder?: string }[],
    zipName: string,
  ) => {
    const ids = items.map((item) => item.id)
    if (ids.length === 0) {
      toastInfo('ダウンロードするファイルを選んでください')
      return
    }
    setProgress({ done: 0, total: ids.length })
    try {
      // 署名付きURLをまとめて取得(キャッシュに残っても意味が無いので都度取得)
      const { data } = await client.query({
        query: MANUAL_DOWNLOAD_URLS_QUERY,
        variables: { ids },
        fetchPolicy: 'network-only',
      })
      const targets: ManualDownloadTarget[] = data?.manualDownloadUrls ?? []
      if (targets.length === 0) {
        toastInfo('ダウンロードできるファイルがありませんでした')
        return
      }

      // 1件だけならZIPにしない
      if (targets.length === 1) {
        const res = await fetch(targets[0].url)
        if (!res.ok) throw new Error(`取得に失敗しました (HTTP ${res.status})`)
        saveBlob(await res.blob(), targets[0].fileName)
        setProgress({ done: 1, total: 1 })
        return
      }

      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      const folderOf = new Map(items.map((item) => [item.id, item.folder]))
      // 名前の重複チェックはZIP内のフォルダごとに行う
      const usedByFolder = new Map<string, Set<string>>()
      let done = 0
      for (const target of targets) {
        const res = await fetch(target.url)
        if (!res.ok) {
          // 1件の失敗で全部を諦めない(残りは入れて渡す)
          console.warn(`ダウンロード失敗: ${target.fileName}`)
          continue
        }
        const folder = folderOf.get(target.id)
        const key = folder ?? ''
        if (!usedByFolder.has(key)) usedByFolder.set(key, new Set())
        const name = uniqueName(usedByFolder.get(key)!, target.fileName)
        const dir = folder ? (zip.folder(folder) ?? zip) : zip
        dir.file(name, await res.blob())
        done += 1
        setProgress({ done, total: targets.length })
      }
      if (done === 0) throw new Error('ファイルを取得できませんでした')

      const blob = await zip.generateAsync({ type: 'blob' })
      saveBlob(blob, `${zipName}.zip`)
    } catch (e) {
      toastError('ダウンロードできませんでした', errorMessage(e, ''))
    } finally {
      setProgress(null)
    }
  }

  return { download, progress }
}
