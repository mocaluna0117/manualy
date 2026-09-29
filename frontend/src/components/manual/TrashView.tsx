import { useMutation, useQuery } from '@apollo/client/react'
import { Box, Button, HStack, Spinner, Text } from '@chakra-ui/react'
import { useState } from 'react'
import { LuRotateCcw, LuTrash2 } from 'react-icons/lu'
import {
  EMPTY_TRASH_MUTATION,
  PURGE_CATEGORIES_MUTATION,
  PURGE_MANUALS_MUTATION,
  RESTORE_CATEGORIES_MUTATION,
  RESTORE_MANUALS_MUTATION,
  TRASHED_CATEGORIES_QUERY,
  TRASHED_MANUALS_QUERY,
} from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'
import {
  ManualItemList,
  ViewModeSwitch,
} from './ManualItemList'
import {
  formatDateTime,
  useViewMode,
} from '../../lib/manualListView'
import { useManualViewer } from './manualViewerContext'
import { errorMessage, toastError, toastInfo, toastSuccess } from '../../lib/toast'

/** ゴミ箱に入れてから自動削除されるまでの日数(サーバー側の設定と合わせる) */
const RETENTION_DAYS = 30

/**
 * ゴミ箱。削除したマニュアルを一定期間ここに置き、元に戻せるようにする。
 * 一覧の見た目は通常のフォルダ表示と同じ部品を使う
 */
export function TrashView() {
  const { data, loading } = useQuery(TRASHED_MANUALS_QUERY, {
    fetchPolicy: 'cache-and-network',
  })
  // フォルダごと捨てたものは、中身をばらさずフォルダ1件として扱う
  const { data: catData } = useQuery(TRASHED_CATEGORIES_QUERY, {
    fetchPolicy: 'cache-and-network',
  })
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const { openManual } = useManualViewer()
  const [viewMode, changeViewMode] = useViewMode()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [checkedFolderIds, setCheckedFolderIds] = useState<Set<string>>(
    new Set(),
  )
  const [busy, setBusy] = useState(false)

  const refetch = {
    refetchQueries: [
      'TrashedManuals',
      'TrashedCategories',
      'Manuals',
      'ManualCategories',
    ],
  }
  const [restoreManuals] = useMutation(RESTORE_MANUALS_MUTATION, refetch)
  const [purgeManuals] = useMutation(PURGE_MANUALS_MUTATION, refetch)
  const [restoreCategories] = useMutation(RESTORE_CATEGORIES_MUTATION, refetch)
  const [purgeCategories] = useMutation(PURGE_CATEGORIES_MUTATION, refetch)
  const [emptyTrash] = useMutation(EMPTY_TRASH_MUTATION, refetch)

  const manuals = data?.trashedManuals ?? []
  const folders = catData?.trashedCategories ?? []
  const checkedCount = checkedIds.size + checkedFolderIds.size
  const total = manuals.length + folders.length

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await action()
      setCheckedIds(new Set())
      setCheckedFolderIds(new Set())
      toastSuccess(done)
    } catch (e) {
      toastError('実行できませんでした', errorMessage(e, ''))
    } finally {
      setBusy(false)
    }
  }

  const handleRestore = () => {
    // 同名のフォルダが既にある場合は中身だけがそちらへ入る。
    // 黙って別の場所に入ると探せなくなるので、戻した後に伝える
    let merged: string[] = []
    let separated: string[] = []
    return run(async () => {
      if (checkedIds.size > 0)
        await restoreManuals({ variables: { ids: [...checkedIds] } })
      // フォルダは中身ごと戻る
      if (checkedFolderIds.size > 0) {
        const { data } = await restoreCategories({
          variables: { ids: [...checkedFolderIds] },
        })
        merged = data?.restoreCategories.mergedInto ?? []
        separated = data?.restoreCategories.restoredSeparately ?? []
      }
    }, `${checkedCount}件を元に戻しました。`).then(() => {
      if (merged.length > 0) {
        toastInfo(
          '同じ名前のフォルダが既にありました',
          `中身をそちらへ戻しました: ${merged.join('、')}`,
        )
      }
      // 鍵の有無が違うものをまとめると、隠していた資料が全員に見えてしまう。
      // 名前を変えて別に戻したことを伝える
      if (separated.length > 0) {
        toastInfo(
          '同じ名前でも見せる範囲が違ったため、別のフォルダとして戻しました',
          `${separated.join('、')}（鍵の状態はそのままです）`,
        )
      }
    })
  }

  const handlePurge = () => {
    if (
      !window.confirm(
        `選択した${checkedCount}件を完全に削除します。` +
          (checkedFolderIds.size > 0
            ? '\nフォルダは中のファイルごと消えます。'
            : '') +
          '\nこの操作は取り消せません。よろしいですか？',
      )
    )
      return
    return run(async () => {
      if (checkedIds.size > 0)
        await purgeManuals({ variables: { ids: [...checkedIds] } })
      if (checkedFolderIds.size > 0)
        await purgeCategories({ variables: { ids: [...checkedFolderIds] } })
    }, `${checkedCount}件を完全に削除しました。`)
  }

  const handleEmpty = () => {
    if (
      !window.confirm(
        `ゴミ箱の${total}件をすべて完全に削除します。\nフォルダは中のファイルごと消えます。\nこの操作は取り消せません。よろしいですか？`,
      )
    )
      return
    return run(() => emptyTrash(), 'ゴミ箱を空にしました。')
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
        <HStack gap={2} fontWeight="bold">
          <LuTrash2 />
          <Text>ゴミ箱</Text>
        </HStack>
        {data && (
          <Text fontSize="sm" color="fg.muted">
            {total}件
          </Text>
        )}
        <Box flex="1" />
        {checkedCount > 0 && (
          <>
            <Button
              size="xs"
              colorPalette="blue"
              variant="outline"
              loading={busy}
              onClick={() => void handleRestore()}
            >
              <LuRotateCcw /> 選択した{checkedCount}件を元に戻す
            </Button>
            <Button
              size="xs"
              colorPalette="red"
              variant="outline"
              loading={busy}
              onClick={() => void handlePurge()}
            >
              <LuTrash2 /> 完全に削除
            </Button>
          </>
        )}
        {total > 0 && checkedCount === 0 && (
          <Button
            size="xs"
            colorPalette="red"
            variant="outline"
            loading={busy}
            onClick={() => void handleEmpty()}
          >
            <LuTrash2 /> ゴミ箱を空にする
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
        folders={folders}
        manuals={manuals}
        isAdmin={isAdmin}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenManual={(manual) => openManual(manual.id, manual.title)}
        checkedIds={checkedIds}
        onToggleCheck={(id) =>
          setCheckedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
        onToggleCheckAll={() => {
          const allOn =
            manuals.every((m) => checkedIds.has(m.id)) &&
            folders.every((f) => checkedFolderIds.has(f.id))
          setCheckedIds(allOn ? new Set() : new Set(manuals.map((m) => m.id)))
          setCheckedFolderIds(
            allOn ? new Set() : new Set(folders.map((f) => f.id)),
          )
        }}
        checkedFolderIds={checkedFolderIds}
        onToggleFolderCheck={(id) =>
          setCheckedFolderIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
        // 捨てた日時を名前の下に出す(いつ消えるかの目安になる)
        renderSubtitle={(manual) =>
          viewMode === 'details' && manual.deletedAt ? (
            <Text fontSize="xs" color="fg.muted" pl={9} pb={1}>
              {formatDateTime(manual.deletedAt)} に削除
            </Text>
          ) : null
        }
      />

      {!loading && total === 0 && (
        <Text mt={6} color="fg.muted" fontSize="sm">
          ゴミ箱は空です
        </Text>
      )}

      {total > 0 && (
        <Text mt={6} fontSize="xs" color="fg.subtle">
          ゴミ箱の中身は検索・AIの回答には出てきません。
          削除から{RETENTION_DAYS}日が過ぎたものは自動的に完全削除されます。
        </Text>
      )}
    </Box>
    </Box>
  )
}
