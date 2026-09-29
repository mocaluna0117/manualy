import { useLazyQuery } from '@apollo/client/react'
import {
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useRef, useState, type ReactNode } from 'react'
import { LuDownload, LuExternalLink, LuX } from 'react-icons/lu'
import { MANUAL_DOWNLOAD_URL_QUERY } from '../../graphql/manuals'
import { fileTypeOf } from '../../lib/fileTypes'
import { toastError } from '../../lib/toast'
import { ManualViewerContext } from './manualViewerContext'
import { useIsTouchDevice } from '../../lib/useIsTouchDevice'

/** アプリ全体に「PDFビューアを開く機能」を配るProvider。モーダル本体もここが1つだけ持つ */
export function ManualViewerProvider({ children }: { children: ReactNode }) {
  const [viewing, setViewing] = useState<{ id: string; title: string } | null>(
    null,
  )
  const [url, setUrl] = useState<string | null>(null)
  // 開いているファイルの形式。ブラウザで表示できるかどうかで見せ方を変える
  const [fileName, setFileName] = useState<string | null>(null)
  const [viewable, setViewable] = useState(true)
  const isTouch = useIsTouchDevice()

  const [fetchDownloadUrl] = useLazyQuery(MANUAL_DOWNLOAD_URL_QUERY, {
    // 署名付きURLは期限があるので毎回取り直す
    fetchPolicy: 'no-cache',
  })

  // 発行済みURLを期限内は使い回す。毎回新しい署名を作るとURLが変わり、
  // ブラウザは別物とみなして同じPDFを何度もダウンロードし直してしまう
  const urlCacheRef = useRef<
    Map<
      string,
      { url: string; fileName: string; viewable: boolean; expiresAt: number }
    >
  >(new Map())
  const URL_REUSE_MS = 10 * 60 * 1000 // 署名の有効期限15分より短くしておく

  const fileType = fileName ? fileTypeOf(fileName) : null

  const openManual = async (id: string, title: string, page?: number | null) => {
    // スマホのブラウザは埋め込みのPDFを描き切れず、1ページ目だけの
    // 動かない絵になってしまう。別のタブ(ブラウザのPDFビューア)に任せる。
    //
    // URLを取りに行く前に先にタブを開くのが要点。待ってから開くと
    // 「押していないのに開いた」とみなされ、ブラウザに塞がれる
    const newTab = isTouch ? window.open('', '_blank') : null

    // #page=N はブラウザ内蔵PDFビューアの機能。該当ページを直接表示する
    // (URLフラグメントはサーバーに送られないので署名の検証にも影響しない)
    const withPage = (base: string) => base + (page ? `#page=${page}` : '')

    /** 受け取ったURLを、別タブかアプリ内のどちらかで開く */
    const show = (target: {
      url: string
      fileName: string
      viewable: boolean
    }) => {
      if (newTab && target.viewable) {
        newTab.location.href = withPage(target.url)
        return
      }
      // ブラウザで開けない形式(Word等)は、白紙のタブを見せても仕方がない。
      // アプリ内で「ダウンロードして開く」を案内する
      newTab?.close()
      setViewing({ id, title })
      setFileName(target.fileName)
      // ページ指定はPDFのビューア機能なので、他の形式では付けない
      setViewable(target.viewable)
      setUrl(target.viewable ? withPage(target.url) : target.url)
    }

    const cached = urlCacheRef.current.get(id)
    if (cached && cached.expiresAt > Date.now()) {
      show(cached)
      return
    }

    // 別タブを開けたときは、そちらが読み込み中の表示を受け持つ
    if (!newTab) {
      setViewing({ id, title })
      setUrl(null) // 前のファイルが一瞬見えないようにリセット
      setFileName(null)
    }

    const { data, error } = await fetchDownloadUrl({ variables: { id } })
    if (data) {
      const target = data.manualDownloadUrl
      urlCacheRef.current.set(id, {
        url: target.url,
        fileName: target.fileName,
        viewable: target.viewableInBrowser,
        expiresAt: Date.now() + URL_REUSE_MS,
      })
      show({
        url: target.url,
        fileName: target.fileName,
        viewable: target.viewableInBrowser,
      })
    } else if (error) {
      newTab?.close()
      urlCacheRef.current.delete(id)
      setViewing(null)
      toastError('開けませんでした', 'このマニュアルは削除された可能性があります')
    }
  }

  const close = () => {
    setViewing(null)
    setUrl(null)
  }

  return (
    <ManualViewerContext.Provider value={{ openManual }}>
      {children}

      <Dialog.Root
        open={viewing !== null}
        onOpenChange={(e) => !e.open && close()}
        // coverは周囲に余白が入り表示面積が削られる。PDFは広いほど
        // スクロール量が減って読みやすいので画面いっぱいに使う
        size="full"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            {/* 高さを確定させる。full指定はminHしか付かず、中のiframeの
                height:100%が解決できずに既定の150pxになってしまう */}
            <Dialog.Content display="flex" flexDirection="column" h="100dvh">
              <Dialog.Header py={3}>
                <HStack justify="space-between" w="100%">
                  <Dialog.Title truncate>{viewing?.title}</Dialog.Title>
                  <HStack gap={2} flexShrink={0}>
                    {url && viewable && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(url, '_blank')}
                      >
                        別タブで開く <LuExternalLink />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={close}>
                      <LuX /> 閉じる
                    </Button>
                  </HStack>
                </HStack>
              </Dialog.Header>

              <Dialog.Body flex="1" p={0} minH={0} display="flex">
                {!url ? (
                  <VStack flex="1" justify="center">
                    <Spinner size="lg" />
                  </VStack>
                ) : viewable && isTouch ? (
                  // スマホは埋め込みのPDFを描き切れないので、ここには
                  // 別タブを開けなかったとき(ブラウザに塞がれた等)だけ来る。
                  // 押せば必ず開けるボタンを出す(押した操作からなら塞がれない)
                  <VStack flex="1" justify="center" gap={4} p={6}>
                    <Text fontSize="sm" color="fg.muted" textAlign="center">
                      スマートフォンでは、このマニュアルは別のタブで開きます。
                    </Text>
                    <Button
                      colorPalette="blue"
                      onClick={() => window.open(url, '_blank')}
                    >
                      <LuExternalLink /> タブで開く
                    </Button>
                  </VStack>
                ) : viewable ? (
                  // ブラウザ内蔵のPDFビューアをそのまま埋め込む。
                  // 高さは%ではなくflexで伸ばす(親の高さ指定に左右されない)
                  <iframe
                    src={url}
                    title={viewing?.title ?? 'マニュアル'}
                    style={{ flex: 1, width: '100%', border: 'none' }}
                  />
                ) : (
                  // Word/Excel/PowerPoint/メールはブラウザで開けない。
                  // 空のタブを見せるより、ダウンロードして開いてもらう
                  <VStack flex="1" justify="center" gap={4} p={6}>
                    <Text fontSize="lg" fontWeight="medium">
                      {fileType?.label ?? 'このファイル'}
                      はブラウザで表示できません
                    </Text>
                    <Text fontSize="sm" color="fg.muted" textAlign="center">
                      ダウンロードして、お使いのアプリで開いてください。
                      <br />
                      中身の文章はAI検索の対象になっています。
                    </Text>
                    <Button
                      colorPalette="blue"
                      onClick={() => window.open(url, '_blank')}
                    >
                      <LuDownload /> ダウンロードして開く
                    </Button>
                  </VStack>
                )}
              </Dialog.Body>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </ManualViewerContext.Provider>
  )
}
