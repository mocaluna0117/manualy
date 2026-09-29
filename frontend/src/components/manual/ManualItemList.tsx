import {
  Box,
  HStack,
  IconButton,
  Input,
  Portal,
  Text,
} from '@chakra-ui/react'
import { useEffect, useState, type ReactNode } from 'react'
import { FcFolder } from 'react-icons/fc'
import { extensionOf } from '../../lib/fileTypes'
import { updatedDateOf } from '../../lib/manualDate'
import {
  NAME_WIDTH_MAX,
  NAME_WIDTH_MIN,
  formatDateTime,
  useNameColumnWidth,
  type SortKey,
  type ViewMode,
} from '../../lib/manualListView'
import { FileIcon } from './FileIcon'
import { useIsTouchDevice } from '../../lib/useIsTouchDevice'
import {
  LuBookOpen,
  LuChevronDown,
  LuChevronUp,
  LuClock,
  LuLayoutGrid,
  LuList,
  LuPencil,
  LuPin,
  LuPinOff,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from 'react-icons/lu'
import type { Category } from '../../graphql/categories'
import type { Manual } from '../../graphql/manuals'
import { formatSize } from '../../lib/format'
import { FOLDER_MIME } from '../layout/Sidebar'
import { Tooltip } from '../ui/Tooltip'

/**
 * マニュアル/フォルダの一覧表示(Windowsのエクスプローラー風)。
 * フォルダ閲覧(ManualExplorer)とキーワード検索結果(ManualSearchResults)の
 * 両方から使う共通部品。表示形式・操作・見た目をここに集約する
 */

/** 表示形式(Windowsの「詳細」と「中アイコン」に相当) */
/** 取り込み状態の目印(色付きアイコン)。正常時は何も出さない */
export function StatusIcon({ manual }: { manual: Manual }) {
  switch (manual.ingestStatus) {
    case 'PENDING':
    case 'PROCESSING':
      return (
        <Tooltip label="取り込み中…">
          <Box color="orange.fg" flexShrink={0}>
            <LuClock size={14} />
          </Box>
        </Tooltip>
      )
    case 'FAILED':
      return (
        <Tooltip label={manual.ingestError ?? '取り込みに失敗しました'}>
          <Box color="fg.error" flexShrink={0}>
            <LuTriangleAlert size={14} />
          </Box>
        </Tooltip>
      )
    case 'COMPLETED':
      return null
  }
}

/** 詳細/アイコン表示の切替ボタン */
export function ViewModeSwitch({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode
  onChange: (mode: ViewMode) => void
}) {
  return (
    <HStack gap={0} borderWidth="1px" borderRadius="md" overflow="hidden">
      <Tooltip label="詳細">
        <IconButton
          aria-label="詳細表示"
          size="xs"
          borderRadius={0}
          variant={viewMode === 'details' ? 'subtle' : 'ghost'}
          onClick={() => onChange('details')}
        >
          <LuList />
        </IconButton>
      </Tooltip>
      <Tooltip label="中アイコン">
        <IconButton
          aria-label="アイコン表示"
          size="xs"
          borderRadius={0}
          variant={viewMode === 'icons' ? 'subtle' : 'ghost'}
          onClick={() => onChange('icons')}
        >
          <LuLayoutGrid />
        </IconButton>
      </Tooltip>
    </HStack>
  )
}

interface ManualItemListProps {
  viewMode: ViewMode
  /** 一緒に並べるフォルダ(ルート表示のときだけ。検索結果では空) */
  folders?: Category[]
  manuals: Manual[]
  /** マニュアル名の描画(検索結果ではキーワードをハイライトする) */
  renderTitle?: (manual: Manual) => ReactNode
  /** マニュアルの下に出す補足(検索結果の本文抜粋など) */
  renderSubtitle?: (manual: Manual) => ReactNode
  isAdmin: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onOpenManual: (manual: Manual) => void
  onOpenFolder?: (folder: Category) => void
  /** 管理者のみ。省略するとドラッグ移動・右クリック操作を出さない */
  onDropToFolder?: (manualId: string, categoryId: string) => void
  onDeleteManual?: (manual: Manual) => void
  onIngestManual?: (manual: Manual) => void
  onTogglePin?: (manual: Manual) => void
  /** 名前を変える(渡されたときだけ右クリックメニューに出る) */
  onRenameManual?: (manual: Manual, title: string) => void
  /** 並べ替え(詳細表示のヘッダー)。省略すると並べ替え不可 */
  sortKey?: SortKey
  sortAsc?: boolean
  onSort?: (key: SortKey) => void
  /** 一括ダウンロード用のチェック。省略するとチェックボックスを出さない */
  checkedIds?: Set<string>
  onToggleCheck?: (id: string) => void
  onToggleCheckAll?: () => void
  /** フォルダのチェック(フォルダ単位でまとめてダウンロードする) */
  checkedFolderIds?: Set<string>
  onToggleFolderCheck?: (id: string) => void
}

/** 一括操作用のチェックボックス(行やタイルのクリックとは独立させる) */
function ItemCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      // 行のクリック(選択)やダブルクリック(開く)を巻き込まない
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={onChange}
      style={{ width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }}
    />
  )
}

export function ManualItemList({
  viewMode,
  folders = [],
  manuals,
  renderTitle,
  renderSubtitle,
  isAdmin,
  selectedId,
  onSelect,
  onOpenManual,
  onOpenFolder,
  onDropToFolder,
  onDeleteManual,
  onIngestManual,
  onTogglePin,
  onRenameManual,
  sortKey,
  sortAsc = true,
  onSort,
  checkedIds,
  onToggleCheck,
  onToggleCheckAll,
  checkedFolderIds,
  onToggleFolderCheck,
}: ManualItemListProps) {
  const selectable = Boolean(checkedIds && onToggleCheck)
  const foldersSelectable = Boolean(checkedFolderIds && onToggleFolderCheck)
  // 全選択の判定は「表示中のフォルダとファイルがすべて入っているか」
  const allChecked =
    manuals.length + folders.length > 0 &&
    manuals.every((m) => checkedIds?.has(m.id)) &&
    (!foldersSelectable || folders.every((f) => checkedFolderIds?.has(f.id)))
  // タッチ端末か。ドラッグ・右クリック・ダブルタップが使えないため、
  // 操作の出し方を変える(マウスとの併用機でも、細い指先より安全側に倒す)
  const isTouch = useIsTouchDevice()
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  // 名前を書き換え中のマニュアル。フォルダ名の変更と同じ操作感にする
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const startRename = (manual: Manual) => {
    setEditingId(manual.id)
    setEditingName(manual.title)
  }
  const commitRename = (manual: Manual) => {
    const next = editingName.trim()
    setEditingId(null)
    if (!next || next === manual.title) return
    onRenameManual?.(manual, next)
  }

  /** 名前の欄。編集中は入力欄に差し替える */
  const nameCell = (manual: Manual, fontSize: string) =>
    editingId === manual.id ? (
      <Input
        size="xs"
        autoFocus
        bg="bg.panel"
        borderColor="border.emphasized"
        value={editingName}
        // 行のクリック(選択・ダブルクリックで開く)に巻き込まれないようにする
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onChange={(e) => setEditingName(e.target.value)}
        onBlur={() => commitRename(manual)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing)
            commitRename(manual)
          if (e.key === 'Escape') setEditingId(null)
        }}
      />
    ) : (
      <Text fontSize={fontSize} truncate>
        {renderTitle ? renderTitle(manual) : manual.title}
      </Text>
    )

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    manual: Manual
  } | null>(null)

  // 右クリックメニューは画面のどこかをクリック/Escで閉じる(Windowsと同じ)。
  // React 18ではクリック系イベント中のuseEffectが同期的に走るため、
  // メニューを開いたイベント自身に反応して即閉じないよう、登録を1tick遅らせる
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const timer = window.setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  /** 選択・ドロップ先のハイライト(Windows風の青) */
  const highlight = (id: string, isDropTarget = false) => ({
    borderWidth: '2px',
    borderColor:
      dragOverFolderId === id && isDropTarget
        ? 'blue.solid'
        : selectedId === id
          ? 'blue.muted'
          : 'transparent',
    bg: selectedId === id ? 'blue.subtle' : undefined,
    _hover: { bg: selectedId === id ? 'blue.subtle' : 'bg.muted' },
    cursor: 'default',
    userSelect: 'none' as const,
  })

  const folderItemProps = (folder: Category) => ({
    // タッチ端末は1タップで開く(ダブルタップは反応しにくい)
    onClick: () => (isTouch ? onOpenFolder?.(folder) : onSelect(folder.id)),
    onDoubleClick: () => onOpenFolder?.(folder),
    // フォルダ自体もドラッグできる(サイドバーのゴミ箱へ運ぶため)。
    // マニュアルのドラッグと区別できるよう専用のデータ形式を使う
    draggable: isAdmin && !isTouch,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(FOLDER_MIME, folder.id)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e: React.DragEvent) => {
      if (!isAdmin || !onDropToFolder) return
      // 運んでいるのがフォルダなら、ここは受け皿にしない
      if (e.dataTransfer.types.includes(FOLDER_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOverFolderId(folder.id)
    },
    onDragLeave: () => setDragOverFolderId(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDragOverFolderId(null)
      const manualId = e.dataTransfer.getData('text/plain')
      if (manualId) onDropToFolder?.(manualId, folder.id)
    },
  })

  const manualItemProps = (manual: Manual) => ({
    // タッチ端末ではドラッグもダブルタップも扱いにくいので、
    // 1タップで開き、ドラッグは無効にする
    draggable: isAdmin && !isTouch,
    onClick: () => (isTouch ? onOpenManual(manual) : onSelect(manual.id)),
    onDoubleClick: () => onOpenManual(manual),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      // このイベント自身がwindowの「閉じる」リスナーに届くと、
      // 開いた瞬間に閉じてメニューが一度も表示されない
      e.stopPropagation()
      onSelect(manual.id)
      setContextMenu({ x: e.clientX, y: e.clientY, manual })
    },
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/plain', manual.id)
      e.dataTransfer.effectAllowed = 'move'
    },
  })

  /** 詳細表示の列ヘッダー(クリックで並べ替え) */
  // 狭い画面では補助的な列を隠し、アイコンと名前に幅を回す。
  // 隠した情報は名前の下に小さく添えるので、失われはしない
  const SUB_COLUMN = { base: 'none', md: 'block' } as const

  // 「名前」列の幅。nullなら余った幅いっぱい(既定)。
  // 幅を決めたときは、名前欄を縮めずに横スクロールで見せる。
  //
  // 補助列を隠す狭い画面(md未満)では、決めた幅を使わない。つまみも出せないので、
  // 使い続けると横スクロールだけが残って戻す手段が無くなる
  const [nameWidth, setNameWidth] = useNameColumnWidth()
  const nameCellProps = nameWidth
    ? {
        w: { base: 'auto', md: `${nameWidth}px` },
        flex: { base: '1', md: '0 0 auto' },
      }
    : { flex: '1' }

  // 名前以外の列と余白の合計(px)。一覧全体の幅をここから計算する。
  // 中身から測る(max-content)と、検索結果の抜粋のような
  // 幅の指定が無い長い文章がそのまま横幅を決めてしまい、
  // 折り返されずに一覧が数千pxまで広がる
  const rowExtraPx =
    16 + // px={2} の左右
    70 + // 種類
    140 + // 更新日
    80 + // サイズ
    8 * (selectable ? 4 : 3) + // gap={2} の合計
    (selectable ? 15 : 0) // チェックボックス
  const listWidth = nameWidth
    ? { base: '100%', md: `${nameWidth + rowExtraPx}px` }
    : '100%'

  /**
   * 見出しの境目をドラッグして「名前」列の幅を変える。
   * サイドバーの幅調整と同じ作り(pointerイベントをwindowで拾う)
   */
  const startNameResize = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation() // 並べ替え(見出しのクリック)を巻き込まない
    // つまみにポインタを固定する。これをしないと、幅が上限・下限で止まった
    // あとにポインタだけ先へ進み、離した場所が見出しセルになる。
    // clickは「押した要素と離した要素の共通の祖先」に飛ぶので、
    // その場合は見出しのonClickが動いて並び順が勝手に変わってしまう
    const grip = e.currentTarget
    grip.setPointerCapture?.(e.pointerId)
    const startX = e.clientX
    const base = nameWidth ?? e.currentTarget.parentElement?.offsetWidth ?? 320
    let last = base
    // 実際に動かしたときだけ幅を確定する。つまみを軽く押しただけで
    // 「自動」から「固定」に変わってしまうと、窓の大きさに追従しなくなる
    let moved = false
    const move = (ev: PointerEvent) => {
      const next = Math.min(
        NAME_WIDTH_MAX,
        Math.max(NAME_WIDTH_MIN, base + (ev.clientX - startX)),
      )
      if (!moved && Math.abs(ev.clientX - startX) < 3) return
      moved = true
      last = next
      setNameWidth(last, false) // 見た目だけ追従させる(保存は離したとき)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (!moved) return
      setNameWidth(last) // 離した時点の幅を保存する
      // ポインタの固定に対応していない環境向けの保険。
      // ドラッグ直後の1回だけクリックを捨てて、並べ替えを防ぐ
      const swallow = (ev: Event) => {
        ev.stopPropagation()
        ev.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      // クリックが来なかったときに居残らないよう、少し経ったら外す
      window.setTimeout(
        () => window.removeEventListener('click', swallow, { capture: true }),
        300,
      )
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // 端末側でドラッグが打ち切られたときも後片付けする
    window.addEventListener('pointercancel', up)
  }
  const SUB_COLUMN_FLEX = { base: 'none', md: 'flex' } as const

  const sortHeader = (label: string, key: SortKey, w?: string) => (
    <HStack
      // 名前列だけは利用者が決めた幅を使う(残りは今まで通り固定幅)
      {...(w
        ? { w, display: SUB_COLUMN_FLEX }
        : { ...nameCellProps, position: 'relative' as const })}
      gap={1}
      cursor={onSort ? 'pointer' : 'default'}
      _hover={onSort ? { color: 'fg' } : undefined}
      onClick={() => onSort?.(key)}
    >
      <Text truncate>{label}</Text>
      {sortKey === key &&
        (sortAsc ? <LuChevronUp size={12} /> : <LuChevronDown size={12} />)}
      {/* 名前と種類の境目。ドラッグで幅を変え、ダブルクリックで既定に戻す。
          スマホでは補助列を隠していて広げる意味がないので出さない */}
      {!w && (
        <Tooltip label="ドラッグで幅を変える(ダブルクリックで元に戻す)">
          <Box
            position="absolute"
            top={-2}
            bottom={-2}
            right={-2}
            w="7px"
            display={SUB_COLUMN}
            cursor="col-resize"
            _hover={{ bg: 'blue.muted' }}
            onPointerDown={startNameResize}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setNameWidth(null)
            }}
          />
        </Tooltip>
      )}
    </HStack>
  )

  return (
    <>
      {viewMode === 'details' && (
        // 幅を決めたときは中身の幅に合わせる(親を横スクロールさせるため)。
        // 見出しと行を同じ箱に入れることで、横に送っても列がずれない
        <Box w={listWidth} minW="100%">
          {/* 列見出しもスクロール中は上端に残す(何の列か見失わないように) */}
          <HStack
            px={2}
            py={2}
            gap={2}
            borderBottomWidth="1px"
            color="fg.muted"
            fontSize="xs"
            position="sticky"
            top={0}
            zIndex={1}
            bg="bg"
          >
            {selectable && (
              <ItemCheckbox
                checked={allChecked}
                onChange={() => onToggleCheckAll?.()}
                label="すべて選択"
              />
            )}
            {sortHeader('名前', 'name')}
            {sortHeader('種類', 'type', '70px')}
            {sortHeader('更新日', 'updatedAt', '140px')}
            {sortHeader('サイズ', 'size', '80px')}
          </HStack>

          {folders.map((folder) => (
            <HStack
              key={folder.id}
              px={2}
              py={1}
              gap={2}
              borderRadius="sm"
              {...highlight(folder.id, true)}
              {...folderItemProps(folder)}
            >
              {selectable &&
                (foldersSelectable ? (
                  <ItemCheckbox
                    checked={checkedFolderIds!.has(folder.id)}
                    onChange={() => onToggleFolderCheck!(folder.id)}
                    label={`${folder.name} を選択`}
                  />
                ) : (
                  // 列の位置を合わせるための余白
                  <Box w="15px" flexShrink={0} />
                ))}
              <HStack {...nameCellProps} gap={2} minW={0}>
                <Box flexShrink={0}>
                  <FcFolder size={18} />
                </Box>
                <Text fontSize="sm" truncate>
                  {folder.name}
                </Text>
              </HStack>
              {/* フォルダに拡張子は無いので、列の位置合わせだけする */}
              <Text
                w="70px"
                display={SUB_COLUMN}
                fontSize="sm"
                color="fg.subtle"
                flexShrink={0}
              >
                フォルダ
              </Text>
              <Text
                w="140px"
                display={SUB_COLUMN}
                fontSize="sm"
                color="fg.muted"
                flexShrink={0}
              >
                {formatDateTime(folder.updatedAt)}
              </Text>
              <Text
                w="80px"
                display={SUB_COLUMN}
                fontSize="sm"
                color="fg.muted"
                flexShrink={0}
                title={`${folder.manualCount ?? 0}件のファイル`}
              >
                {formatSize(folder.totalSize ?? 0)}
              </Text>
            </HStack>
          ))}

          {manuals.map((manual) => (
            <Box key={manual.id}>
              <HStack
                px={2}
                py={1}
                gap={2}
                borderRadius="sm"
                {...highlight(manual.id)}
                {...manualItemProps(manual)}
                title={manual.title}
              >
                {selectable && (
                  <ItemCheckbox
                    checked={checkedIds!.has(manual.id)}
                    onChange={() => onToggleCheck!(manual.id)}
                    label={`${manual.title} を選択`}
                  />
                )}
                <HStack {...nameCellProps} gap={2} minW={0}>
                  <Box flexShrink={0}>
                    <FileIcon fileName={manual.fileName} size={18} />
                  </Box>
                  {nameCell(manual, 'sm')}
                  {isAdmin && manual.categoryPinned && (
                    <Tooltip label="ピン留め済み(AIの再分類では動きません)">
                      <Box color="fg.muted" flexShrink={0}>
                        <LuPin size={12} />
                      </Box>
                    </Tooltip>
                  )}
                  <StatusIcon manual={manual} />
                </HStack>
                <Text
                  w="70px"
                  display={SUB_COLUMN}
                  fontSize="sm"
                  color="fg.muted"
                  flexShrink={0}
                >
                  {extensionOf(manual.fileName)}
                </Text>
                {(() => {
                  const { date, isFallback } = updatedDateOf(manual)
                  return (
                    <Text
                      w="140px"
                      display={SUB_COLUMN}
                      fontSize="sm"
                      color={isFallback ? 'fg.subtle' : 'fg.muted'}
                      flexShrink={0}
                      title={
                        isFallback
                          ? '元ファイルの更新日が分からないため、登録した日を表示しています'
                          : '元ファイルの最終更新日'
                      }
                    >
                      {formatDateTime(date ?? undefined)}
                    </Text>
                  )
                })()}
                <Text
                  w="80px"
                  display={SUB_COLUMN}
                  fontSize="sm"
                  color="fg.muted"
                  flexShrink={0}
                >
                  {formatSize(manual.size)}
                </Text>
              </HStack>
              {/* 狭い画面では列を隠しているので、その分をここに小さく添える */}
              <Text
                display={{ base: 'block', md: 'none' }}
                pl={9}
                pb={1}
                fontSize="xs"
                color="fg.subtle"
              >
                {[
                  extensionOf(manual.fileName),
                  formatDateTime(updatedDateOf(manual).date ?? undefined),
                  formatSize(manual.size),
                ]
                  .filter((v) => v && v !== '—')
                  .join(' ・ ')}
              </Text>
              {/* 本文ヒットの抜粋など(検索結果のみ) */}
              {renderSubtitle?.(manual)}
            </Box>
          ))}
        </Box>
      )}

      {viewMode === 'icons' && (
        <Box
          display="grid"
          gridTemplateColumns="repeat(auto-fill, minmax(112px, 1fr))"
          gap={1}
        >
          {folders.map((folder) => (
            <Box
              key={folder.id}
              w="112px"
              px={1}
              py={2}
              borderRadius="md"
              textAlign="center"
              position="relative"
              {...highlight(folder.id, true)}
              {...folderItemProps(folder)}
            >
              <Box display="flex" justifyContent="center">
                <FcFolder size={48} />
              </Box>
              {foldersSelectable && (
                <Box position="absolute" top="1" left="3">
                  <ItemCheckbox
                    checked={checkedFolderIds!.has(folder.id)}
                    onChange={() => onToggleFolderCheck!(folder.id)}
                    label={`${folder.name} を選択`}
                  />
                </Box>
              )}
              <Text fontSize="xs" mt={1} lineClamp={2} wordBreak="break-all">
                {folder.name}
              </Text>
            </Box>
          ))}

          {manuals.map((manual) => (
            <Box
              key={manual.id}
              w="112px"
              px={1}
              py={2}
              borderRadius="md"
              textAlign="center"
              position="relative"
              {...highlight(manual.id)}
              {...manualItemProps(manual)}
              title={manual.title}
            >
              <Box display="flex" justifyContent="center">
                <FileIcon fileName={manual.fileName} size={48} />
              </Box>
              {/* 状態とピンは右上にまとめ、左上はチェックボックスに空ける */}
              <HStack position="absolute" top="1" right="3" gap={1}>
                {isAdmin && manual.categoryPinned && (
                  <Tooltip label="ピン留め済み(AIの再分類では動きません)">
                    <Box color="fg.muted">
                      <LuPin size={14} />
                    </Box>
                  </Tooltip>
                )}
                <StatusIcon manual={manual} />
              </HStack>
              {selectable && (
                <Box position="absolute" top="1" left="3">
                  <ItemCheckbox
                    checked={checkedIds!.has(manual.id)}
                    onChange={() => onToggleCheck!(manual.id)}
                    label={`${manual.title} を選択`}
                  />
                </Box>
              )}
              {editingId === manual.id ? (
                <Box mt={1}>{nameCell(manual, 'xs')}</Box>
              ) : (
                <Text fontSize="xs" mt={1} lineClamp={2} wordBreak="break-all">
                  {renderTitle ? renderTitle(manual) : manual.title}
                </Text>
              )}
              {/* 名前だけでは種類が分からないので、拡張子を添える */}
              <Text fontSize="10px" color="fg.subtle">
                {extensionOf(manual.fileName)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* 右クリックメニュー(Windows風) */}
      {contextMenu && (
        <Portal>
          <Box
            position="fixed"
            left={`${contextMenu.x}px`}
            top={`${contextMenu.y}px`}
            zIndex={2000}
            bg="bg.panel"
            borderWidth="1px"
            borderRadius="md"
            boxShadow="lg"
            py={1}
            minW="180px"
          >
            <MenuButton onClick={() => onOpenManual(contextMenu.manual)}>
              <LuBookOpen /> 開く
            </MenuButton>
            {isAdmin && onRenameManual && (
              <MenuButton onClick={() => startRename(contextMenu.manual)}>
                <LuPencil /> 名前を変更
              </MenuButton>
            )}
            {isAdmin && onTogglePin && (
              <MenuButton onClick={() => onTogglePin(contextMenu.manual)}>
                {contextMenu.manual.categoryPinned ? (
                  <>
                    <LuPinOff /> ピン留めを解除
                  </>
                ) : (
                  <>
                    <LuPin /> ピン留め(再分類で動かさない)
                  </>
                )}
              </MenuButton>
            )}
            {isAdmin &&
              onIngestManual &&
              contextMenu.manual.ingestStatus === 'FAILED' && (
                <MenuButton onClick={() => onIngestManual(contextMenu.manual)}>
                  <LuRefreshCw /> 再取り込み
                </MenuButton>
              )}
            {isAdmin && onDeleteManual && (
              <MenuButton
                color="fg.error"
                onClick={() => onDeleteManual(contextMenu.manual)}
              >
                <LuTrash2 /> 削除
              </MenuButton>
            )}
          </Box>
        </Portal>
      )}
    </>
  )
}

/** 右クリックメニューの1項目 */
function MenuButton({
  children,
  onClick,
  color,
}: {
  children: ReactNode
  onClick: () => void
  color?: string
}) {
  return (
    <HStack
      as="button"
      w="100%"
      px={3}
      py={2}
      gap={2}
      fontSize="sm"
      color={color}
      _hover={{ bg: 'bg.muted' }}
      onClick={onClick}
    >
      {children}
    </HStack>
  )
}
