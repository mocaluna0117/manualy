import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import { FcOpenedFolder } from 'react-icons/fc'
import { LuBot, LuTrash2, LuUser } from 'react-icons/lu'
import {
  DELETE_EMPTY_CATEGORIES_MUTATION,
  RECLASSIFY_STATUS_QUERY,
  type EmptiedCategory,
} from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'
import { errorMessage, toastError, toastInfo } from '../../lib/toast'

/** 再分類の完了を見に行く間隔(ミリ秒)。数分かかる処理なので急がない */
const POLL_INTERVAL = 30000

/** 「そのままにする」を選んだ回を覚えておく場所(再読み込みしても蒸し返さない) */
const DISMISSED_KEY = 'manualy.emptiedFolders.dismissed'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null // プライベートモード等で読めなくても動く
  }
}

interface EmptiedFolderCleanupProps {
  /** 今開いているフォルダ。消した先を開いたままにしないために使う */
  selectedCategoryId: string | null
  /** 開いていたフォルダを消したときにホームへ戻すため */
  onSelectCategory: (category: null) => void
}

/**
 * 再分類で空になったフォルダを片付けるための確認モーダル。
 *
 * 再分類はフォルダを作りはするが消しはしないので、中身がまとめられた結果
 * 空の箱がサイドバーに残る。完了後にその場で選んで捨てられるようにする。
 *
 * このアプリはサイドバーを左右+スマホ用に複数マウントするため、
 * ここをサイドバーに置くとモーダルが同時に何枚も開いてしまう。
 * AppLayoutに1つだけ置くこと。
 */
export function EmptiedFolderCleanup({
  selectedCategoryId,
  onSelectCategory,
}: EmptiedFolderCleanupProps) {
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'

  // サイドバーのボタンからでもチャットからでも拾えるよう、開始経路によらず見ている。
  // サーバ側が「今も生きていて今も空」のフォルダだけに絞って返すので、
  // 実行の瞬間に立ち会えなくても(別端末・再読み込み後でも)片付けられる
  const { data } = useQuery(RECLASSIFY_STATUS_QUERY, {
    skip: !isAdmin,
    pollInterval: POLL_INTERVAL,
    fetchPolicy: 'network-only',
  })
  const status = data?.reclassifyStatus

  // 片付けたか「そのままにする」を選んだ回の印。同じ回では開き直さない
  const [dismissed, setDismissed] = useState<string | null>(readDismissed)
  // Escや背景クリックで閉じた分。これは「今は見ない」だけなので保存しない
  // (取り違えると、うっかり閉じただけで二度と出せなくなる)
  const [hidden, setHidden] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const targets: EmptiedCategory[] =
    status && !status.running ? status.emptiedCategories : []
  const runId = status?.finishedAt ?? null
  const open =
    targets.length > 0 &&
    runId !== null &&
    runId !== dismissed &&
    runId !== hidden

  // チェックは触られるまで既定のまま。手作業で作った箱は最初から外す
  // (意図して用意した箱を流れ作業で消してしまわないため)。
  // どの回に対する選択かを一緒に持ち、表示中に別の再分類が終わったら
  // 古い選択を引きずらず既定に戻す
  const [picked, setPicked] = useState<{
    run: string | null
    ids: Set<string>
  } | null>(null)
  const checkedIds =
    picked && picked.run === runId
      ? picked.ids
      : new Set(targets.filter((c) => c.createdByAi).map((c) => c.id))

  // 実際に消しに行く対象。一覧から消えたフォルダを選んだままにしない
  const selectedIds = targets
    .filter((c) => checkedIds.has(c.id))
    .map((c) => c.id)

  const client = useApolloClient()
  const [deleteEmptyCategories] = useMutation(DELETE_EMPTY_CATEGORIES_MUTATION)

  /** この回はもう出さない。次に再分類すれば別の回として改めて出る */
  const dismiss = () => {
    if (runId) {
      try {
        localStorage.setItem(DISMISSED_KEY, runId)
      } catch {
        // 保存できなくても、この画面を開いている間は出さない
      }
      setDismissed(runId)
    }
    setPicked(null)
  }

  /** Escや背景クリックで閉じたとき。次に開いたときはまた出す */
  const hide = () => {
    if (busy) return
    setHidden(runId)
  }

  const handleDelete = async () => {
    if (selectedIds.length === 0) return
    setBusy(true)
    try {
      const { data: result } = await deleteEmptyCategories({
        variables: { ids: selectedIds },
      })
      const deletedIds = result?.deleteEmptyCategories.deletedIds ?? []
      const skipped = result?.deleteEmptyCategories.skipped ?? []
      // 一覧の取り直しに失敗しても削除自体は済んでいる。
      // ここで例外にすると「削除できませんでした」と嘘を伝えることになる
      await client
        .refetchQueries({
          include: ['ManualCategories', 'Manuals', 'TrashedCategories'],
        })
        .catch(() => undefined)
      // 開いていたフォルダを「実際に消した」場合だけそこから出る。
      // 見送った(中身が入っていた)フォルダは開いたままでよい
      if (selectedCategoryId && deletedIds.includes(selectedCategoryId)) {
        onSelectCategory(null)
      }
      dismiss()
      toastInfo(
        deletedIds.length > 0
          ? `${deletedIds.length}個のフォルダをゴミ箱に移しました`
          : 'ゴミ箱に移したフォルダはありません',
        (deletedIds.length > 0 ? '取り消したい場合はゴミ箱から戻せます。' : '') +
          // 空でなくなっていた分は必ず伝える(黙って残すと消えたように見える)
          (skipped.length > 0
            ? `\n中身が入っていたのでそのままにしました: ${skipped.join('、')}`
            : ''),
      )
    } catch (e) {
      // 削除そのものに失敗したとき。閉じずに、選択も残して再試行できるようにする
      toastError('フォルダを削除できませんでした', errorMessage(e, ''))
    } finally {
      // 失敗しても閉じられなくならないよう、必ず戻す
      setBusy(false)
    }
  }

  const toggle = (id: string) => {
    const ids = new Set(checkedIds)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    setPicked({ run: runId, ids })
  }

  const allOn = targets.length > 0 && targets.every((c) => checkedIds.has(c.id))
  const byUserCount = targets.filter((c) => !c.createdByAi).length

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && hide()}
      // 狭い画面では全画面にする(横がはみ出して読めなくなるため)
      size={{ base: 'full', md: 'lg' }}
      scrollBehavior="inside"
      // 背景クリックで消えると、片付けの機会を落としたのか自分で閉じたのか
      // 分からなくなる。閉じ方はEscかボタンに限る
      closeOnInteractOutside={false}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>空になったフォルダの整理</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <Text fontSize="sm" color="fg.muted" mb={1}>
                再分類で中身が他のフォルダへ移り、
                {targets.length}個のフォルダが空になりました。
                削除するものを選んでください。
              </Text>
              <Text fontSize="xs" color="fg.subtle" mb={3}>
                削除してもゴミ箱に入るだけなので、あとから戻せます。
                ここで消さなかったフォルダは、サイドバーからいつでも消せます。
                {byUserCount > 0 &&
                  `自分で作ったフォルダ${byUserCount}個は、うっかり消さないよう最初から外してあります。`}
              </Text>

              <HStack mb={2}>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setPicked({
                      run: runId,
                      ids: allOn ? new Set() : new Set(targets.map((c) => c.id)),
                    })
                  }
                >
                  {allOn ? 'すべて外す' : 'すべて選ぶ'}
                </Button>
                <Text fontSize="xs" color="fg.muted">
                  {selectedIds.length} / {targets.length} 個を選択中
                </Text>
              </HStack>

              <VStack gap={2} align="stretch">
                {targets.map((target) => (
                  <HStack
                    key={target.id}
                    as="label"
                    gap={2}
                    p={2}
                    borderWidth="1px"
                    borderRadius="md"
                    cursor="pointer"
                    _hover={{ bg: 'bg.subtle' }}
                  >
                    <input
                      type="checkbox"
                      aria-label={`${target.name} を削除する`}
                      checked={checkedIds.has(target.id)}
                      disabled={busy}
                      onChange={() => toggle(target.id)}
                      style={{ width: 15, height: 15, cursor: 'pointer' }}
                    />
                    <FcOpenedFolder style={{ flexShrink: 0 }} />
                    <Box flex="1" minW={0}>
                      <Text fontSize="sm" overflowWrap="anywhere">
                        {target.name}
                      </Text>
                    </Box>
                    {target.createdByAi ? (
                      <Badge colorPalette="purple" variant="surface" gap={1}>
                        <LuBot /> AIが作成
                      </Badge>
                    ) : (
                      <Badge colorPalette="blue" variant="surface" gap={1}>
                        <LuUser /> 手作業で作成
                      </Badge>
                    )}
                  </HStack>
                ))}
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="ghost" onClick={dismiss} disabled={busy}>
                そのままにする
              </Button>
              <Button
                colorPalette="red"
                loading={busy}
                disabled={selectedIds.length === 0}
                onClick={() => void handleDelete()}
              >
                <LuTrash2 />
                {selectedIds.length}個をゴミ箱へ
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
