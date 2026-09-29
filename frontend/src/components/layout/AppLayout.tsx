import { Box, Flex, HStack, IconButton, Image } from '@chakra-ui/react'
import { useState, type ReactNode } from 'react'
import { LuPanelLeft, LuPanelRight } from 'react-icons/lu'
import type { Category } from '../../graphql/categories'
import { useLayoutMode, type LayoutMode } from '../../lib/settings'
import { MobileSidebar, SidebarPanel, type SidebarSections } from './Sidebar'
import { Tooltip } from '../ui/Tooltip'
import { EmptiedFolderCleanup } from '../manual/EmptiedFolderCleanup'

interface AppLayoutProps {
  children: ReactNode
  selectedCategoryId: string | null
  selectedConversationId: string | null
  onSelectCategory: (category: Category | null) => void
  onSelectConversation: (conversationId: string) => void
  onSelectUncategorized: () => void
  onSelectTrash: () => void
  onSelectManualsRoot: () => void // エクスプローラーのルート(全フォルダ)を開く
  onSearch: (keyword: string) => void
}

// レイアウト設定 → 左右のパネルに何を出すか(rightがnullなら1枚だけ)
const PANELS: Record<
  LayoutMode,
  { left: SidebarSections; right: SidebarSections | null }
> = {
  single: { left: 'both', right: null },
  'chat-left': { left: 'chat', right: 'manuals' },
  'chat-right': { left: 'manuals', right: 'chat' },
}

const COLLAPSE_KEY = 'manualSearch.sidebarCollapsed'

/** 閉じた状態を左右それぞれ記憶する(次回も同じ状態で開く) */
function useCollapsed(side: 'left' | 'right') {
  const key = `${COLLAPSE_KEY}.${side}`
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === 'true'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(key, String(next))
      } catch {
        // 保存できない環境では今回だけ有効
      }
      return next
    })
  return [collapsed, toggle] as const
}

/** 画面全体の骨組み: サイドバー(スマホではDrawer) + メインエリア */
export function AppLayout({ children, ...props }: AppLayoutProps) {
  const layout = useLayoutMode()
  const panels = PANELS[layout]
  const [leftCollapsed, toggleLeft] = useCollapsed('left')
  const [rightCollapsed, toggleRight] = useCollapsed('right')
  const hasRight = panels.right !== null

  return (
    // dvh(dynamic viewport height)を使う。vhだとスマホのソフトキーボードや
    // アドレスバーで表示領域が縮んだときに下部の入力欄が隠れてしまう
    <Flex h="100dvh">
      {!leftCollapsed && (
        <SidebarPanel
          side="left"
          sections={panels.left}
          showFooter
          onToggleCollapse={toggleLeft}
          {...props}
        />
      )}
      <Box
        as="main"
        flex="1"
        minW={0}
        overflowY="auto"
        // 縦だけautoにすると横も自動でautoになるため、明示して横漏れを止める
        overflowX="hidden"
        // 閉じているときは、浮いているボタンと中身が重ならないよう余白を空ける。
        // 左は「開く」+「ホーム」の2つぶん、右は1つぶん
        pl={leftCollapsed ? { base: 0, md: '88px' } : undefined}
        pr={hasRight && rightCollapsed ? { base: 0, md: '48px' } : undefined}
      >
        {children}
      </Box>
      {hasRight && !rightCollapsed && (
        // アカウント欄は左パネルにあるので、右パネルでは出さない
        <SidebarPanel
          side="right"
          sections={panels.right!}
          showFooter={false}
          onToggleCollapse={toggleRight}
          {...props}
        />
      )}

      {/* 閉じているときに出す「開く」ボタンとホーム(PCのみ。スマホはハンバーガー)。
          サイドバーを閉じていてもホーム(新しいチャット)に戻れるようにする */}
      {leftCollapsed && (
        <HStack
          position="fixed"
          top={3}
          left={3}
          zIndex={20}
          gap={0}
          display={{ base: 'none', md: 'flex' }}
        >
          <Tooltip label="サイドバーを開く">
            <IconButton
              aria-label="サイドバーを開く"
              size="sm"
              variant="ghost"
              color="fg.muted"
              _hover={{ color: 'fg', bg: 'bg.emphasized' }}
              onClick={toggleLeft}
            >
              <LuPanelLeft />
            </IconButton>
          </Tooltip>
          <Tooltip label="新しいチャット(ホーム)">
            <IconButton
              aria-label="新しいチャット(ホーム)"
              size="sm"
              variant="ghost"
              _hover={{ bg: 'bg.emphasized' }}
              onClick={() => props.onSelectCategory(null)}
            >
              <Image src="/favicon.svg" alt="" boxSize="20px" />
            </IconButton>
          </Tooltip>
        </HStack>
      )}
      {hasRight && rightCollapsed && (
        <Tooltip label="サイドバーを開く">
        <IconButton
          aria-label="サイドバーを開く"
          size="sm"
          variant="ghost"
          color="fg.muted"
          _hover={{ color: 'fg', bg: 'bg.emphasized' }}
          position="fixed"
          top={3}
          right={3}
          zIndex={20}
          display={{ base: 'none', md: 'flex' }}
          onClick={toggleRight}
        >
          <LuPanelRight />
        </IconButton>
        </Tooltip>
      )}

      <MobileSidebar {...props} />

      {/* 再分類で空になったフォルダの片付け確認。
          サイドバーは左右+スマホ用に複数マウントされるため、
          見張りはここに1つだけ置く(でないとモーダルが何枚も開く) */}
      <EmptiedFolderCleanup
        selectedCategoryId={props.selectedCategoryId}
        onSelectCategory={props.onSelectCategory}
      />
    </Flex>
  )
}
