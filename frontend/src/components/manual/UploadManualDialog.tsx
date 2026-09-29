import { useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Input,
  Portal,
  Select,
  createListCollection,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useMemo, useRef, useState } from 'react'
import { LuBot, LuCheck, LuTriangleAlert, LuX } from 'react-icons/lu'
import { CATEGORIES_QUERY } from '../../graphql/categories'
import {
  CREATE_UPLOAD_URL_MUTATION,
  MANUALS_QUERY,
  RECLASSIFY_SELECTED_MUTATION,
  REGISTER_MANUAL_MUTATION,
  type RegisterOutcome,
} from '../../graphql/manuals'
import { formatSize } from '../../lib/format'
import { FileIcon } from './FileIcon'
import {
  ACCEPT_ATTR,
  SUPPORTED_LABEL,
  fileTypeOf,
  stripExtension,
} from '../../lib/fileTypes'
import {
  errorMessage,
  toastError,
  toastInfo,
  toastReport,
  toastSuccess,
} from '../../lib/toast'

interface UploadManualDialogProps {
  open: boolean
  onClose: () => void
}

// 1ファイル分のアップロード状態
interface UploadItem {
  file: File
  title: string
  status: 'pending' | 'uploading' | 'done' | 'error'
  outcome?: RegisterOutcome // 完了後: 新規追加 / 既存を更新 / 古いのでスキップ
  /** 登録できたマニュアルのID。格納先を後から追いかけるために持つ */
  manualId?: string
  // スキップされたときに判定根拠を画面で説明するための日時
  existingDate?: string | null
  incomingDate?: string | null
  error?: string
}

/** 日時を読みやすい形にする(不明ならその旨を返す) */
function formatDate(iso?: string | null): string {
  if (!iso) return '不明'
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function StatusBadge({ item }: { item: UploadItem }) {
  switch (item.status) {
    case 'pending':
      return <Badge colorPalette="gray">待機中</Badge>
    case 'uploading':
      return <Spinner size="xs" />
    case 'done':
      if (item.outcome === 'UPDATED') {
        return <Badge colorPalette="blue">更新</Badge>
      }
      if (item.outcome === 'SKIPPED_OLDER') {
        return <Badge colorPalette="orange">⏭ スキップ</Badge>
      }
      return <Badge colorPalette="green">✅ 完了</Badge>
    case 'error':
      return <Badge colorPalette="red">❌ 失敗</Badge>
  }
}

/** 完了後に「何が起きたか」を1行で説明する */
function outcomeNote(item: UploadItem): string | null {
  switch (item.outcome) {
    case 'UPDATED':
      return '同名の既存マニュアルを、この新しいファイルで置き換えました'
    case 'SKIPPED_OLDER':
      // 判定の根拠になった日時を必ず見せる(なぜスキップされたか分かるように)
      return (
        `既存マニュアルの方が新しいため取り込みませんでした` +
        `（既存: ${formatDate(item.existingDate)} / 今回: ${formatDate(item.incomingDate)}）`
      )
    default:
      return null
  }
}

/** カテゴリ欄の「AIにおまかせ」を表す値(実在のフォルダIDとは別物) */
const AUTO = '__auto'

export function UploadManualDialog({ open, onClose }: UploadManualDialogProps) {
  const [items, setItems] = useState<UploadItem[]>([])
  // おすすめの「AIにおまかせ」を最初から選んでおく
  const [categoryId, setCategoryId] = useState(AUTO)
  const [uploading, setUploading] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 「AIにおまかせ」は取り込みのあとに振り分ける。そこで新しいフォルダが
  // 作られると手元の一覧にまだ無く、名前が引けずに「フォルダ に入りました」
  // としか出せない。決まるまで一覧も見に行く
  const [watching, setWatching] = useState(false)
  const { data: categoriesData } = useQuery(CATEGORIES_QUERY, {
    fetchPolicy: 'cache-and-network',
    pollInterval: open && watching ? 3000 : 0,
  })
  // Selectに渡す選択肢(先頭は「未分類」= 値なし)
  const categoryCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: '未分類', value: '' },
          ...(categoriesData?.manualCategories ?? []).map((c) => ({
            label: c.name,
            value: c.id,
          })),
        ],
      }),
    [categoriesData],
  )
  // 既存マニュアルの一覧。アップロード前は同名の予告に、
  // アップロード後は「どのフォルダに入ったか」の確認に使う
  const { data: existingData } = useQuery(MANUALS_QUERY, {
    fetchPolicy: 'cache-and-network',
    // 「AIにおまかせ」は取り込みが終わってから振り分けるので、
    // 決まるまで見に行く。決まったら止める(無駄に叩き続けない)。
    // 閉じている間は見に行かない(裏で叩き続けないため)
    pollInterval: open && watching ? 3000 : 0,
  })
  const existingFileNames = new Set(
    existingData?.manuals.map((m) => m.fileName) ?? [],
  )

  // 登録できたマニュアルの「今の状態」を引く。取り込みと自動分類が
  // 終わっているかを見て、格納先を出す
  const manualById = new Map(
    (existingData?.manuals ?? []).map((m) => [m.id, m]),
  )
  // 鍵付きかどうかも持つ。AIにおまかせで鍵付きフォルダへ入った場合に
  // 🔒 を出して、一般の利用者からは見えないことをその場で伝える
  const categoryById = new Map(
    (categoriesData?.manualCategories ?? []).map((c) => [c.id, c]),
  )

  /** 1件の格納先を、今分かっている範囲で文章にする */
  const placement = (item: UploadItem) => {
    if (item.status !== 'done' || !item.manualId) return null
    const manual = manualById.get(item.manualId)
    // 一覧の取り直しが追いつく前は、まだ何も言えない
    if (!manual) return { text: '格納先を確認しています…', tone: 'fg.muted' }
    if (manual.ingestStatus === 'FAILED') {
      return {
        text: '取り込みに失敗したため、AI検索の対象になっていません',
        tone: 'fg.error',
      }
    }
    if (manual.ingestStatus !== 'COMPLETED') {
      return {
        text: categoryId === AUTO
          ? '読み取り中… 終わるとAIが自動で振り分けます'
          : '読み取り中…',
        tone: 'fg.muted',
      }
    }
    if (!manual.categoryId) {
      return { text: '📁 未分類に入りました', tone: 'fg.muted' }
    }
    const category = categoryById.get(manual.categoryId)
    if (category?.adminOnly) {
      return {
        text: `🔒 ${category.name} に入りました(一般の利用者には表示されません)`,
        tone: 'orange.fg',
      }
    }
    return {
      text: `📁 ${category?.name ?? 'フォルダ'} に入りました`,
      tone: 'green.fg',
    }
  }

  // まだ決まっていないものが残っている間だけ見に行く
  const pending = items.some((item) => {
    if (item.status !== 'done' || !item.manualId) return false
    const manual = manualById.get(item.manualId)
    if (!manual) return true
    if (
      manual.ingestStatus === 'PENDING' ||
      manual.ingestStatus === 'PROCESSING'
    ) {
      return true
    }
    // 取り込みが終わっていても、AIが新しく作ったフォルダは手元の一覧に
    // まだ無いことがある。名前が引けるまで待つ
    return !!manual.categoryId && !categoryById.has(manual.categoryId)
  })
  if (pending !== watching) setWatching(pending)

  // いま上げた分だけを対象にする。一覧から選び直さずに済むようにする
  // (全件の再分類と違い、ほかのマニュアルは一切動かない)
  const uploadedIds = items
    .filter(
      (i) => i.status === 'done' && i.manualId && i.outcome !== 'SKIPPED_OLDER',
    )
    .map((i) => i.manualId!)
  // 中身が読めていないものは分類できないので、読み終わるまで待つ
  const readyIds = uploadedIds.filter(
    (id) => manualById.get(id)?.ingestStatus === 'COMPLETED',
  )
  const failedIds = uploadedIds.filter(
    (id) => manualById.get(id)?.ingestStatus === 'FAILED',
  )
  const waitingCount = uploadedIds.length - readyIds.length - failedIds.length

  const [createUploadUrl] = useMutation(CREATE_UPLOAD_URL_MUTATION)
  const [registerManual] = useMutation(REGISTER_MANUAL_MUTATION, {
    // 登録後に一覧クエリを取り直し、開いているカテゴリ一覧へ即反映する
    refetchQueries: ['Manuals'],
  })

  /** 選択/ドロップされたファイルをリストに追加(対応していない形式は弾く) */
  const addFiles = (fileList: FileList | null) => {
    if (!fileList) return
    const files = Array.from(fileList)
    const accepted = files.filter((f) => fileTypeOf(f.name))
    const rejected = files.filter((f) => !fileTypeOf(f.name))
    if (rejected.length > 0) {
      toastError(
        `${rejected.length}件は対応していない形式です`,
        `${rejected.map((f) => f.name).join('\n')}\n対応形式: ${SUPPORTED_LABEL}`,
      )
    }
    setItems((prev) => [
      ...prev,
      ...accepted.map((file) => ({
        file,
        // タイトルの初期値はファイル名(拡張子なし)。あとから編集できる
        title: stripExtension(file.name),
        status: 'pending' as const,
      })),
    ])
  }

  const [reclassifySelected] = useMutation(RECLASSIFY_SELECTED_MUTATION, {
    refetchQueries: ['Manuals', 'ManualCategories'],
  })

  /**
   * いま上げた分だけをAIでまとめて分類する。
   *
   * 「AIにおまかせ」は1件ずつ取り込み直後に判断するので、まとめて上げた
   * 関連資料がばらけることがある。ここでは全部の中身が読めた状態で
   * 一度に見るので、似たものが同じフォルダにまとまりやすい。
   */
  const classifyUploaded = async () => {
    if (readyIds.length === 0) return
    setClassifying(true)
    try {
      const { data } = await reclassifySelected({
        variables: { ids: readyIds },
      })
      const r = data?.reclassifySelectedManuals
      if (!r) return
      toastReport(
        r.movedCount > 0
          ? `${r.movedCount}件を分類しました`
          : '移動はありませんでした',
        (r.movedCount > 0
          ? r.moved
              .map(
                (m) =>
                  `・${m.title} → ${m.adminOnly ? '🔒' : '📁'} ${m.categoryName}`,
              )
              .join('\n')
          : '今の分類のままです。') +
          (r.createdCategories.length > 0
            ? `\n\n新しく作ったフォルダ: ${r.createdCategories.join('、')}`
            : '') +
          (r.skippedPinned.length > 0
            ? `\n\nピン留めのため動かしませんでした: ${r.skippedPinned.join('、')}`
            : '') +
          (r.skippedLocked.length > 0
            ? `\n\n鍵付きフォルダの中にあるため動かしませんでした: ${r.skippedLocked.join('、')}`
            : '') +
          (r.conflictedCount > 0
            ? `\n\n⚖️ ${r.conflictedCount}件は分類ルールが2つ以上当てはまったため、動かしていません` +
              '\n(一覧の「分類の判断待ち」から行き先を選んでください)'
            : ''),
      )
    } catch (e) {
      toastError('分類できませんでした', errorMessage(e, ''))
    } finally {
      setClassifying(false)
    }
  }

  const resetAndClose = () => {
    if (uploading || classifying) return // 処理中は閉じられない
    setItems([])
    setCategoryId(AUTO)
    onClose()
  }

  /** 指定した1件をアップロードして登録する(強制差し替えの再実行にも使う) */
  const uploadOne = async (
    index: number,
    forceReplace = false,
  ): Promise<RegisterOutcome | 'error' | null> => {
    const item = items[index]
    if (!item) return null
    setItems((prev) =>
      prev.map((it, idx) => (idx === index ? { ...it, status: 'uploading' } : it)),
    )
    try {
      // 1) アップロード専用URLをもらう
      const { data } = await createUploadUrl({
        variables: { fileName: item.file.name },
      })
      if (!data) throw new Error('URLの発行に失敗しました')
      const { uploadUrl, fileKey } = data.createManualUploadUrl

      // 2) ストレージへ直接PUT
      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        // 保存されるオブジェクトのContent-Typeはここで決まる。
        // 形式に合った値を送っておく(PDF固定のままだと種別を誤って持つ)
        headers: {
          'Content-Type':
            fileTypeOf(item.file.name)?.mimeType ?? 'application/octet-stream',
        },
        body: item.file,
      })
      if (!putResponse.ok) {
        throw new Error(`アップロードに失敗しました (HTTP ${putResponse.status})`)
      }

      // 3) メタデータをDBに登録(取り込みは自動で始まる)
      const { data: registered } = await registerManual({
        variables: {
          input: {
            title: item.title.trim() || item.file.name,
            fileKey,
            fileName: item.file.name,
            size: item.file.size,
            categoryId:
              categoryId && categoryId !== AUTO ? categoryId : undefined,
            // 「AIにおまかせ」なら取り込み完了後に自動でカテゴリが付く
            autoCategorize: categoryId === AUTO || undefined,
            // 同名マニュアルがある場合の新旧判定に使う(ブラウザが持つファイルの更新日時)
            fileLastModified: new Date(item.file.lastModified).toISOString(),
            forceReplace: forceReplace || undefined,
          },
        },
      })
      setItems((prev) =>
        prev.map((it, idx) =>
          idx === index
            ? {
                ...it,
                status: 'done',
                outcome: registered?.registerManual.outcome,
                manualId: registered?.registerManual.manual.id,
                existingDate: registered?.registerManual.existingFileLastModified,
                incomingDate: registered?.registerManual.incomingFileLastModified,
              }
            : it,
        ),
      )
      return registered?.registerManual.outcome ?? null
    } catch (e) {
      setItems((prev) =>
        prev.map((it, idx) =>
          idx === index
            ? {
                ...it,
                status: 'error',
                error: e instanceof Error ? e.message : '不明なエラー',
              }
            : it,
        ),
      )
      return 'error'
    }
  }

  /** 1件ずつ順番にアップロード。'done'はスキップするので失敗分の再試行も同じボタン */
  const handleUpload = async () => {
    if (items.length === 0) return
    setUploading(true)
    // 画面の外からでも終わりが分かるよう、まとめて通知する。
    // 件数は各回の結果を数える(itemsの状態は反映が遅れることがあるため)
    let created = 0
    let updated = 0
    let skipped = 0
    let failed = 0
    for (let i = 0; i < items.length; i++) {
      if (items[i].status === 'done') continue
      const outcome = await uploadOne(i)
      if (outcome === 'error') failed++
      else if (outcome === 'UPDATED') updated++
      else if (outcome === 'SKIPPED_OLDER') skipped++
      else if (outcome === 'CREATED') created++
    }
    setUploading(false)

    const detail = [
      updated > 0 ? `${updated}件は既存を更新` : '',
      skipped > 0 ? `${skipped}件は既存の方が新しいためスキップ` : '',
      // 「AIにおまかせ」は取り込みのあとに振り分けるので、その旨を添える
      created + updated > 0 && categoryId === AUTO
        ? '読み取りが終わると、AIが自動でフォルダへ振り分けます'
        : '',
    ]
      .filter(Boolean)
      .join('\n')

    if (failed > 0) {
      toastError(
        `${failed}件のアップロードに失敗しました`,
        [created + updated > 0 ? `${created + updated}件は成功` : '', detail]
          .filter(Boolean)
          .join('\n') || undefined,
      )
    } else if (created + updated > 0) {
      toastSuccess(
        `${created + updated}件のアップロードが完了しました`,
        detail || undefined,
      )
    } else if (skipped > 0) {
      toastInfo('アップロードしたファイルはありません', detail || undefined)
    }
  }

  /** スキップされた1件を、判定を無視して差し替える */
  const handleForceReplace = async (index: number) => {
    setUploading(true)
    await uploadOne(index, true)
    setUploading(false)
  }

  const doneCount = items.filter((i) => i.status === 'done').length
  const hasError = items.some((i) => i.status === 'error')
  const allDone = items.length > 0 && doneCount === items.length
  // アップロードボタンが実際に処理する件数(終わったものは対象外)
  const uploadableCount = items.filter((i) => i.status !== 'done').length
  const skippedCount = items.filter(
    (i) => i.outcome === 'SKIPPED_OLDER',
  ).length

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && resetAndClose()}
      // 狭い画面では全画面にする(横がはみ出して読めなくなるため)
      size={{ base: 'full', md: 'lg' }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>マニュアルをアップロード</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack gap={4} align="stretch">
                {/* ファイル選択/ドロップゾーン */}
                <Box
                  borderWidth="2px"
                  borderStyle="dashed"
                  borderColor="border.emphasized"
                  borderRadius="md"
                  p={6}
                  textAlign="center"
                  cursor="pointer"
                  _hover={{ borderColor: 'blue.solid', bg: 'blue.subtle' }}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    addFiles(e.dataTransfer.files)
                  }}
                >
                  <Text color="fg.muted">
                    クリックして選択、またはここにファイルをドラッグ&ドロップ
                  </Text>
                  <Text fontSize="xs" color="fg.subtle" mt={1}>
                    {SUPPORTED_LABEL}に対応。複数まとめて選択できます
                  </Text>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPT_ATTR}
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      addFiles(e.target.files)
                      e.target.value = '' // 同じファイルを選び直せるように
                    }}
                  />
                </Box>

                {/* ファイルごとの状態リスト */}
                {items.length > 0 && (
                  <VStack gap={3} align="stretch" maxH="260px" overflowY="auto">
                    {items.map((item, i) => (
                      <Box key={`${item.file.name}-${i}`}>
                        <HStack gap={2}>
                          <StatusBadge item={item} />
                          {/* どの形式として扱われるかを、上げる前に確かめられる */}
                          <Box flexShrink={0}>
                            <FileIcon fileName={item.file.name} size={16} />
                          </Box>
                          <Input
                            size="sm"
                            flex="1"
                            value={item.title}
                            disabled={uploading || item.status === 'done'}
                            onChange={(e) =>
                              setItems((prev) =>
                                prev.map((it, idx) =>
                                  idx === i ? { ...it, title: e.target.value } : it,
                                ),
                              )
                            }
                          />
                          <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                            {formatSize(item.file.size)}
                          </Text>
                          {!uploading && item.status !== 'done' && (
                            <IconButton
                              aria-label="リストから外す"
                              size="xs"
                              variant="ghost"
                              onClick={() =>
                                setItems((prev) =>
                                  prev.filter((_, idx) => idx !== i),
                                )
                              }
                            >
                              <LuX />
                            </IconButton>
                          )}
                        </HStack>

                        {/* アップロード前: 同名マニュアルがある場合の予告 */}
                        {item.status === 'pending' &&
                          existingFileNames.has(item.file.name) && (
                            <HStack gap={1} fontSize="xs" color="orange.fg" mt={1} align="flex-start">
                              <LuTriangleAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                              <Text fontSize="xs">
                                同名のマニュアルが既にあります。ファイルの更新日が新しい方だけが残ります
                              </Text>
                            </HStack>
                          )}

                        {/* アップロード後: どのフォルダに入ったか */}
                        {(() => {
                          const p = placement(item)
                          return p ? (
                            <Text fontSize="xs" color={p.tone} mt={1}>
                              {p.text}
                            </Text>
                          ) : null
                        })()}

                        {/* アップロード後: 何が起きたかの説明 */}
                        {item.status === 'done' && outcomeNote(item) && (
                          <Text
                            fontSize="xs"
                            color={
                              item.outcome === 'UPDATED'
                                ? 'blue.fg'
                                : 'orange.fg'
                            }
                            mt={1}
                          >
                            {outcomeNote(item)}
                          </Text>
                        )}

                        {/* スキップされた場合の逃げ道: 判定を無視して差し替える */}
                        {item.status === 'done' &&
                          item.outcome === 'SKIPPED_OLDER' && (
                            <Button
                              size="xs"
                              variant="outline"
                              colorPalette="orange"
                              mt={1}
                              loading={uploading}
                              onClick={() => void handleForceReplace(i)}
                            >
                              それでも差し替える
                            </Button>
                          )}

                        {item.error && (
                          <Text fontSize="xs" color="fg.error" mt={1}>
                            {item.error}
                          </Text>
                        )}
                      </Box>
                    ))}
                  </VStack>
                )}

                {/* カテゴリ(全ファイル共通)。
                    おすすめの「AIにおまかせ」は<option>だと装飾できないので
                    ドロップダウンの外に出して目立つボタンにする */}
                <div>
                  <Text fontSize="sm" mb={1}>
                    カテゴリ（任意・全ファイルに適用）
                  </Text>
                  <Button
                    w="100%"
                    justifyContent="flex-start"
                    colorPalette="purple"
                    variant={categoryId === AUTO ? 'solid' : 'outline'}
                    disabled={uploading}
                    mb={2}
                    onClick={() =>
                      setCategoryId(categoryId === AUTO ? '' : AUTO)
                    }
                  >
                    <LuBot />
                    <Text>AIにおまかせ（内容から自動分類）</Text>
                    <Box flex="1" />
                    {categoryId === AUTO ? (
                      <LuCheck />
                    ) : (
                      <Badge colorPalette="purple" variant="surface">
                        おすすめ
                      </Badge>
                    )}
                  </Button>
                  {/* ネイティブの<select>はフォルダが増えると上方向に開いて
                      画面外へはみ出すため、位置を指定できるSelectを使う */}
                  <Select.Root
                    collection={categoryCollection}
                    disabled={uploading || categoryId === AUTO}
                    value={[categoryId === AUTO ? '' : categoryId]}
                    onValueChange={(e) => setCategoryId(e.value[0] ?? '')}
                    positioning={{ placement: 'bottom-start', sameWidth: true }}
                    size="sm"
                  >
                    <Select.HiddenSelect />
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="未分類" />
                      </Select.Trigger>
                      <Select.IndicatorGroup>
                        <Select.Indicator />
                      </Select.IndicatorGroup>
                    </Select.Control>
                    <Portal>
                      <Select.Positioner>
                        {/* 候補が多いときはこの中でスクロールさせる */}
                        <Select.Content maxH="240px" overflowY="auto">
                          {categoryCollection.items.map((item) => (
                            <Select.Item item={item} key={item.value}>
                              {item.label}
                              <Select.ItemIndicator />
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Portal>
                  </Select.Root>
                  {categoryId === AUTO && (
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      内容を読んで自動で振り分けます（合うフォルダが無ければ作成）。
                      フォルダを自分で選ぶ場合は、もう一度ボタンを押して解除してください。
                    </Text>
                  )}
                </div>

                {/* 進捗サマリ */}
                {items.length > 1 && (uploading || doneCount > 0) && !allDone && (
                  <Text fontSize="sm" color="fg.muted">
                    {doneCount} / {items.length} 件完了
                  </Text>
                )}

                {/* 全部終わったときは、次に何ができるかまで伝える。
                    ボタンが押せない理由が分からないままにしない */}
                {allDone && !uploading && (
                  <Text fontSize="sm" color="green.fg">
                    {skippedCount > 0
                      ? `${doneCount - skippedCount}件を取り込みました（${skippedCount}件はスキップ）。`
                      : `${doneCount}件のアップロードが終わりました。`}
                    続けて上げる場合は、上の枠にファイルを追加してください。
                  </Text>
                )}

                {/* いま上げた分だけをまとめて分類する。一覧へ移動して
                    同じファイルを選び直す手間を省くためのもので、
                    ほかのマニュアルには一切触らない。
                    全件成功を条件にしない(1件でも失敗すると出せなくなり、
                    その1件が直らない限りこの機能に手が届かなくなるため) */}
                {!uploading && uploadedIds.length > 0 && (
                  <Box
                    borderWidth="1px"
                    borderColor="purple.emphasized"
                    borderRadius="md"
                    p={3}
                  >
                    <HStack gap={2} flexWrap="wrap">
                      <Button
                        size="xs"
                        colorPalette="purple"
                        variant="outline"
                        loading={classifying}
                        disabled={readyIds.length === 0}
                        onClick={() => void classifyUploaded()}
                      >
                        <LuBot /> いま上げた{readyIds.length}件だけをAIで分類
                      </Button>
                      {waitingCount > 0 && (
                        <HStack gap={1} color="fg.muted" fontSize="xs">
                          <Spinner size="xs" />
                          <Text>読み取り中の{waitingCount}件を待っています</Text>
                        </HStack>
                      )}
                    </HStack>
                    <Text fontSize="xs" color="fg.muted" mt={2}>
                      {categoryId === AUTO
                        ? '1件ずつではなく、上げた分をまとめて見て分類し直します（似た資料が同じフォルダにまとまりやすくなります）。'
                        : 'いま上げた分だけが対象です。ほかのマニュアルは動きません。'}
                      ピン留めしたものと鍵付きフォルダの中のものは動かしません。
                    </Text>
                    {failedIds.length > 0 && (
                      <Text fontSize="xs" color="fg.error" mt={1}>
                        取り込みに失敗した{failedIds.length}件は、中身が読めないため対象外です。
                      </Text>
                    )}
                  </Box>
                )}
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button
                variant="ghost"
                onClick={resetAndClose}
                disabled={uploading || classifying}
              >
                {allDone ? '閉じる' : 'キャンセル'}
              </Button>
              {/* 終わったあともボタンは出したままにする。消してしまうと
                  「アップロードできなくなった」ように見えるため、
                  押せないことは無効表示で示す(ファイルを足せばまた押せる) */}
              <Button
                colorPalette="blue"
                onClick={handleUpload}
                loading={uploading}
                disabled={uploadableCount === 0}
              >
                {hasError
                  ? '失敗分を再試行'
                  : `アップロード${uploadableCount > 1 ? `（${uploadableCount}件）` : ''}`}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
