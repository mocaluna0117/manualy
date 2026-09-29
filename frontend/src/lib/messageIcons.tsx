import { Box } from '@chakra-ui/react'
import type { ReactNode } from 'react'
import { FcFolder } from 'react-icons/fc'
import {
  LuCircleCheck,
  LuCircleStop,
  LuImage,
  LuLoaderCircle,
  LuLock,
  LuPin,
  LuRuler,
  LuTrash2,
  LuTriangleAlert,
} from 'react-icons/lu'

/**
 * 管理操作の結果メッセージ(バックエンドが書く文章)の行頭にある絵文字を、
 * UIの他の部分と揃ったアイコンに差し替える。
 *
 * 絵文字はDBに保存済みの過去メッセージにも入っているため、
 * バックエンドの文字列を変えるのではなく表示側で読み替える方式にしている
 */
const ICONS: Record<string, { icon: ReactNode; color?: string }> = {
  '📁': { icon: <FcFolder size={16} /> },
  '📏': { icon: <LuRuler size={15} />, color: 'blue.fg' },
  '🗑': { icon: <LuTrash2 size={15} />, color: 'fg.muted' },
  // 実行中を表すので、回転させて「進行中」らしく見せる
  '⏳': {
    icon: (
      <Box
        as={LuLoaderCircle}
        boxSize="15px"
        animation="spin 1.4s linear infinite"
        css={{
          '@keyframes spin': {
            from: { transform: 'rotate(0deg)' },
            to: { transform: 'rotate(360deg)' },
          },
        }}
      />
    ),
    color: 'orange.fg',
  },
  '⚠️': { icon: <LuTriangleAlert size={15} />, color: 'fg.error' },
  '⚠': { icon: <LuTriangleAlert size={15} />, color: 'fg.error' },
  '✅': { icon: <LuCircleCheck size={15} />, color: 'green.fg' },
  '⏹️': { icon: <LuCircleStop size={15} />, color: 'fg.muted' },
  '⏹': { icon: <LuCircleStop size={15} />, color: 'fg.muted' },
  '🔒': { icon: <LuLock size={14} />, color: 'orange.fg' },
  '📌': { icon: <LuPin size={14} />, color: 'fg.muted' },
  '📷': { icon: <LuImage size={14} /> },
}

/** 行頭の絵文字にマッチする正規表現(長い表記から順に試す) */
const LEADING_EMOJI = new RegExp(
  `^(${Object.keys(ICONS)
    .sort((a, b) => b.length - a.length)
    .join('|')})\\s*`,
)

/** 文字列の先頭にある絵文字を取り出す。無ければnull */
export function splitLeadingIcon(
  text: string,
): { icon: ReactNode; rest: string } | null {
  const match = text.match(LEADING_EMOJI)
  if (!match) return null
  const found = ICONS[match[1]]
  if (!found) return null
  return {
    icon: (
      <Box as="span" color={found.color} display="inline-flex" flexShrink={0}>
        {found.icon}
      </Box>
    ),
    rest: text.slice(match[0].length),
  }
}

/** 文中に残った絵文字(📌など)もアイコンに置き換える */
export function withInlineIcons(text: string): ReactNode {
  const keys = Object.keys(ICONS).sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(${keys.join('|')})`, 'g')
  const parts = text.split(pattern)
  if (parts.length === 1) return text
  return parts.map((part, i) => {
    const found = ICONS[part]
    if (!found) return <span key={i}>{part}</span>
    return (
      <Box
        key={i}
        as="span"
        color={found.color}
        display="inline-flex"
        verticalAlign="-2px"
        mx="1px"
      >
        {found.icon}
      </Box>
    )
  })
}
