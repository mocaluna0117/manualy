import { Dialog, HStack, IconButton, Image, Portal } from '@chakra-ui/react'
import { LuX } from 'react-icons/lu'

interface ImagePreviewProps {
  /** 表示する画像のURL。nullなら閉じている */
  src: string | null
  /** 見出しに出す名前(省略時は「画像」) */
  label?: string
  onClose: () => void
}

/**
 * 画像を大きく見るためのダイアログ。
 *
 * 小さく並べたままだと文字が読めず、添えた画像が合っているか確かめられない。
 * 入力中の内容はそのまま残るので、見てから続きを書ける
 */
export function ImagePreview({ src, label, onClose }: ImagePreviewProps) {
  return (
    <Dialog.Root
      open={src !== null}
      onOpenChange={(e) => !e.open && onClose()}
      size={{ base: 'full', md: 'xl' }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <HStack justify="space-between" w="100%" gap={2}>
                <Dialog.Title truncate>{label || '画像'}</Dialog.Title>
                <IconButton
                  aria-label="閉じる"
                  size="sm"
                  variant="ghost"
                  flexShrink={0}
                  onClick={onClose}
                >
                  <LuX />
                </IconButton>
              </HStack>
            </Dialog.Header>
            <Dialog.Body pb={4}>
              {src && (
                <Image
                  src={src}
                  alt={label || '画像'}
                  w="100%"
                  maxH="75vh"
                  objectFit="contain"
                />
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
