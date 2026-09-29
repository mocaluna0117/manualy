import { useMutation, useQuery } from '@apollo/client/react'
import { Box, Button, Heading, HStack, Spinner, Text } from '@chakra-ui/react'
import { Fragment, useState } from 'react'
import { LuDownload, LuSearch, LuTrash2 } from 'react-icons/lu'
import {
  DELETE_MANUAL_MUTATION,
  DELETE_MANUALS_MUTATION,
  INGEST_MANUAL_MUTATION,
  RENAME_MANUAL_MUTATION,
  SEARCH_MANUALS_QUERY,
  SET_MANUAL_PINNED_MUTATION,
  type Manual,
} from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'
import {
  ManualItemList,
  ViewModeSwitch,
} from './ManualItemList'
import {
  useViewMode,
} from '../../lib/manualListView'
import { useBulkDownload } from './useBulkDownload'
import { useManualViewer } from './manualViewerContext'
import { errorMessage, toastError, toastSuccess } from '../../lib/toast'

interface ManualSearchResultsProps {
  keyword: string
}

/** 文中のキーワードをハイライトして表示する */
function HighlightedText({ text, keyword }: { text: string; keyword: string }) {
  // 正規表現の特殊文字をエスケープしてから、キーワード位置で分割する
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === keyword.toLowerCase() ? (
          <Text as="mark" key={i} bg="yellow.subtle" color="fg">
            {part}
          </Text>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  )
}

/**
 * キーワード検索の結果一覧。
 * 見た目と操作はフォルダ表示(ManualExplorer)と同じ共通部品を使い、
 * 検索結果ならではの「キーワードのハイライト」と「本文の抜粋」を足す
 */
export function ManualSearchResults({ keyword }: ManualSearchResultsProps) {
  const { data, loading } = useQuery(SEARCH_MANUALS_QUERY, {
    variables: { keyword },
  })
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const { openManual } = useManualViewer()
  const [viewMode, changeViewMode] = useViewMode()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 検索結果からもまとめてダウンロードできるようにする(キーワードで絞ってから一括)。
  // キーワードが変わるとApp側がkeyでこの画面ごと作り直すので、選択の解除は要らない
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const { download, progress } = useBulkDownload()

  const [deleteManual] = useMutation(DELETE_MANUAL_MUTATION, {
    refetchQueries: ['SearchManuals', 'Manuals'],
  })
  const [ingestManual] = useMutation(INGEST_MANUAL_MUTATION, {
    refetchQueries: ['SearchManuals', 'Manuals'],
  })
  const [renameManual] = useMutation(RENAME_MANUAL_MUTATION, {
    // 検索結果とマニュアル一覧の両方を最新にする
    refetchQueries: ['SearchManuals', 'Manuals'],
  })
  const [setManualPinned] = useMutation(SET_MANUAL_PINNED_MUTATION, {
    refetchQueries: ['SearchManuals', 'Manuals'],
  })
  const [deleteManuals] = useMutation(DELETE_MANUALS_MUTATION, {
    refetchQueries: ['SearchManuals', 'Manuals', 'ManualCategories'],
  })
  const [deleting, setDeleting] = useState(false)

  /** チェックした検索結果をまとめて削除する(管理者のみ) */
  const deleteChecked = async () => {
    if (
      !window.confirm(
        `選択した${checkedIds.size}件のファイルを削除します。\n元に戻せません。よろしいですか？`,
      )
    )
      return
    setDeleting(true)
    try {
      const { data: result } = await deleteManuals({
        variables: { ids: [...checkedIds] },
      })
      setCheckedIds(new Set())
      toastSuccess(`${result?.deleteManuals ?? 0}件を削除しました`)
    } catch (e) {
      toastError('削除できませんでした', errorMessage(e, ''))
    } finally {
      setDeleting(false)
    }
  }

  const results = data?.searchManuals ?? []
  const manuals = results.map((r) => r.manual)
  // 本文ヒットの抜粋をマニュアルIDから引けるようにする
  const snippets = new Map(
    results.filter((r) => r.snippet).map((r) => [r.manual.id, r.snippet!]),
  )

  const handleDelete = async (manual: Manual) => {
    if (!window.confirm(`「${manual.title}」を削除しますか？元に戻せません。`))
      return
    try {
      await deleteManual({ variables: { id: manual.id } })
    } catch (e) {
      toastError('削除できませんでした', errorMessage(e, ''))
    }
  }

  return (
    // ツールバーは固定、一覧だけをスクロールさせる。
    // ファイルが増えてもダウンロードや表示切替のボタンに手が届くようにする
    <Box
      h="100%"
      display="flex"
      flexDirection="column"
      pt={{ base: 14, md: 6 }}
    >
      <HStack
        px={{ base: 4, md: 6 }}
        pb={4}
        gap={2}
        flexWrap="wrap"
        flexShrink={0}
      >
        <Heading size="sm" display="flex" alignItems="center" gap={2}>
          <LuSearch /> 「{keyword}」の検索結果
        </Heading>
        {data && (
          <Text fontSize="sm" color="fg.muted">
            {results.length}件
          </Text>
        )}
        <Box flex="1" />
        {checkedIds.size > 0 && isAdmin && (
          <Button
            size="xs"
            colorPalette="red"
            variant="outline"
            loading={deleting}
            onClick={() => void deleteChecked()}
          >
            <LuTrash2 /> 選択した{checkedIds.size}件を削除
          </Button>
        )}
        {checkedIds.size > 0 && (
          <Button
            size="xs"
            colorPalette="blue"
            variant="outline"
            loading={progress !== null}
            onClick={() =>
              void download(
                [...checkedIds].map((id) => ({ id })),
                `検索結果(${keyword})`,
              )
            }
          >
            <LuDownload /> 選択した{checkedIds.size}件をダウンロード
          </Button>
        )}
        <ViewModeSwitch viewMode={viewMode} onChange={changeViewMode} />
      </HStack>

      <Box
        flex="1"
        minH={0}
        overflowY="auto"
        // 名前の列を広げたときに横へ送れるようにする(一覧の実装は共通)
        overflowX="auto"
        px={{ base: 4, md: 6 }}
        pb={{ base: 4, md: 6 }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedId(null)
        }}
      >
      {loading && !data && <Spinner />}

      <ManualItemList
        viewMode={viewMode}
        manuals={manuals}
        isAdmin={isAdmin}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenManual={(manual) => openManual(manual.id, manual.title)}
        onDeleteManual={(manual) => void handleDelete(manual)}
        onIngestManual={(manual) => {
          // 取り込み中の再実行はサーバーが弾く(BadRequest)。受け止めないと
          // unhandled rejection になるだけで、画面には何も出ない
          void ingestManual({ variables: { id: manual.id } }).catch(
            (e: unknown) =>
              toastError('再取り込みを開始できませんでした', errorMessage(e, '')),
          )
        }}
        onRenameManual={(manual, title) => {
          void renameManual({ variables: { id: manual.id, title } }).catch(
            (e: unknown) =>
              toastError('名前を変更できませんでした', errorMessage(e, '')),
          )
        }}
        onTogglePin={(manual) =>
          void setManualPinned({
            variables: { id: manual.id, pinned: !manual.categoryPinned },
          })
        }
        checkedIds={checkedIds}
        onToggleCheck={(id) =>
          setCheckedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
        onToggleCheckAll={() =>
          setCheckedIds((prev) =>
            manuals.every((m) => prev.has(m.id))
              ? new Set()
              : new Set(manuals.map((m) => m.id)),
          )
        }
        renderTitle={(manual) => (
          <HighlightedText text={manual.title} keyword={keyword} />
        )}
        renderSubtitle={(manual) => {
          const snippet = snippets.get(manual.id)
          if (!snippet || viewMode !== 'details') return null
          return (
            <Text fontSize="xs" color="fg.muted" pl={9} pb={1}>
              <HighlightedText text={snippet} keyword={keyword} />
            </Text>
          )
        }}
      />

      {!loading && results.length === 0 && (
        <Text mt={6} color="fg.muted" fontSize="sm">
          「{keyword}」に一致するマニュアルは見つかりませんでした
        </Text>
      )}
    </Box>
    </Box>
  )
}
