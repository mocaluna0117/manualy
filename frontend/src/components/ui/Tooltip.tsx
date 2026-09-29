import { Portal, Tooltip as ChakraTooltip } from '@chakra-ui/react'
import type { ReactElement, ReactNode } from 'react'

/** カーソルを合わせてから出るまでの待ち時間(ミリ秒)。
 *  ブラウザ標準のtitle属性は1秒以上かかるうえ変えられないので、
 *  自前のツールチップにして短くしている */
const OPEN_DELAY = 500

interface TooltipProps {
  /** 出す文言。空なら何も出さずに中身だけ描画する */
  label?: ReactNode
  /** ツールチップを付ける対象(ボタンなど)。asChildで包むため単一要素にする */
  children: ReactElement
  /** メニューのトリガー等に重ねるとき、外側から渡ってくるpropsを中身へ流す。
   *  これが無いと<Popover.Trigger asChild>で包んだときに
   *  クリックが中のボタンまで届かない(React 19なのでrefもここに含まれる) */
  [key: string]: unknown
}

/**
 * ボタンなどの説明を出すツールチップ。
 * 置き場所は自動で調整され、画面外へはみ出さない
 */
export function Tooltip({ label, children, ...rest }: TooltipProps) {
  if (!label) return children
  return (
    <ChakraTooltip.Root openDelay={OPEN_DELAY} closeDelay={100}>
      <ChakraTooltip.Trigger asChild {...rest}>
        {children}
      </ChakraTooltip.Trigger>
      <Portal>
        <ChakraTooltip.Positioner>
          <ChakraTooltip.Content>
            <ChakraTooltip.Arrow>
              <ChakraTooltip.ArrowTip />
            </ChakraTooltip.Arrow>
            {label}
          </ChakraTooltip.Content>
        </ChakraTooltip.Positioner>
      </Portal>
    </ChakraTooltip.Root>
  )
}
