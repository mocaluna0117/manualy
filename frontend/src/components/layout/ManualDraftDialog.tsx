import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import { LuCheck, LuCopy, LuDownload, LuRefreshCw, LuX } from 'react-icons/lu'
import { toastError, toastSuccess } from '../../lib/toast'

interface ManualDraftDialogProps {
  /** 下書きの元にした質問。nullなら閉じている */
  question: string | null
  /** Markdownの下書き(生成中は空) */
  draft: string
  /** 下書きの材料にした既存マニュアル */
  sources: { title: string }[]
  loading: boolean
  onDraftChange: (draft: string) => void
  onRegenerate: () => void
  onClose: () => void
}

/** ファイル名に使えない文字を落とす */
function safeFileName(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || 'マニュアル下書き'
}

/**
 * 答えられなかった質問から作ったマニュアルの下書きを見せる画面。
 *
 * 「足りない領域が分かる」だけでは埋まらない。章立てと分かっている範囲を
 * AIに先に書かせて、担当者はそれを直すところから始められるようにする。
 *
 * 生成そのものは呼び出し側(ボタンを押した操作)が行う。ここは見せるだけ
 */
export function ManualDraftDialog({
  question,
  draft,
  sources,
  loading,
  onDraftChange,
  onRegenerate,
  onClose,
}: ManualDraftDialogProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toastError('コピーできませんでした')
    }
  }

  /** Markdownのまま保存する(WordやNotionにそのまま貼れる) */
  const save = () => {
    const blob = new Blob([draft], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${safeFileName(question ?? '')}.md`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    toastSuccess('下書きを保存しました')
  }

  return (
    <Dialog.Root
      open={question !== null}
      onOpenChange={(e) => !e.open && onClose()}
      size={{ base: 'full', md: 'xl' }}
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <HStack justify="space-between" w="100%" gap={2}>
                <Dialog.Title>マニュアルの下書き</Dialog.Title>
                <Button size="sm" variant="ghost" onClick={onClose}>
                  <LuX /> 閉じる
                </Button>
              </HStack>
            </Dialog.Header>

            <Dialog.Body>
              <Text fontSize="xs" color="fg.subtle" mb={2}>
                答えられなかった質問「{question}」から作った下書きです。
              </Text>

              {loading && (
                <HStack gap={2} color="fg.muted" py={6} justify="center">
                  <Spinner size="sm" />
                  <Text fontSize="sm">
                    関連する資料を探して、下書きを作っています…
                  </Text>
                </HStack>
              )}

              {!loading && draft && (
                <VStack gap={2} align="stretch">
                  {/* その場で直せるようにする。清書は別のアプリで行うにしても、
                      明らかな間違いはここで消しておける方が早い */}
                  <Textarea
                    value={draft}
                    onChange={(e) => onDraftChange(e.target.value)}
                    rows={20}
                    fontSize="sm"
                    fontFamily="mono"
                  />
                  {sources.length > 0 && (
                    <Box>
                      <Text fontSize="xs" color="fg.subtle">
                        参考にした既存のマニュアル(近い内容が既にあるかもしれません):
                      </Text>
                      <Text fontSize="xs" color="fg.muted" mt={1}>
                        {[...new Set(sources.map((s) => s.title))]
                          .slice(0, 5)
                          .join(' / ')}
                      </Text>
                    </Box>
                  )}
                </VStack>
              )}
            </Dialog.Body>

            <Dialog.Footer>
              <Text fontSize="xs" color="fg.subtle" me="auto">
                「(要確認)」の箇所は、事実を確かめてから埋めてください
              </Text>
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={onRegenerate}
              >
                <LuRefreshCw /> 作り直す
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!draft}
                onClick={() => void copy()}
              >
                {copied ? <LuCheck /> : <LuCopy />} コピー
              </Button>
              <Button
                size="sm"
                colorPalette="blue"
                disabled={!draft}
                onClick={save}
              >
                <LuDownload /> .mdで保存
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
