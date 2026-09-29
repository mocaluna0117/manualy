import {
  BsEnvelopeFill,
  BsFiletypeDocx,
  BsFiletypePdf,
  BsFiletypePptx,
  BsFiletypeXlsx,
} from 'react-icons/bs'
import { BsFileEarmark } from 'react-icons/bs'
import { fileIconOf } from '../../lib/fileTypes'

/**
 * ファイル形式ごとのアイコン。Windowsのエクスプローラーのように、
 * 一目で何のファイルか分かるようにする。
 *
 * Word/Excel等の公式ロゴは商標のため配布されていないので、拡張子入りの
 * 書類アイコンに、それぞれのアプリでおなじみの色を付けている。
 * 色は明るい方の公式トーンを選んであり、ライト/ダークのどちらでも読める。
 */
const ICON_BY_TYPE = {
  pdf: { Icon: BsFiletypePdf, color: '#E5484D' }, // 赤
  word: { Icon: BsFiletypeDocx, color: '#2B7CD3' }, // 青
  excel: { Icon: BsFiletypeXlsx, color: '#21A366' }, // 緑
  powerpoint: { Icon: BsFiletypePptx, color: '#ED6C47' }, // 橙
  mail: { Icon: BsEnvelopeFill, color: '#0F6CBD' }, // Outlookの青
  other: { Icon: BsFileEarmark, color: 'currentColor' },
} as const

export function FileIcon({
  fileName,
  size,
}: {
  fileName: string
  size: number
}) {
  const { Icon, color } = ICON_BY_TYPE[fileIconOf(fileName)]
  return <Icon size={size} color={color} />
}
