import { useLazyQuery, useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import {
  LuCircleHelp,
  LuFilePen,
  LuFileText,
  LuSparkles,
  LuTrendingUp,
} from 'react-icons/lu'
import { errorMessage, toastError } from '../../lib/toast'
import { ManualDraftDialog } from './ManualDraftDialog'
import {
  DRAFT_MANUAL_MUTATION,
  ANALYTICS_SUMMARY_QUERY,
  MANUAL_USAGE_QUERY,
  QUESTION_THEMES_QUERY,
  UNANSWERED_QUESTIONS_QUERY,
} from '../../graphql/analytics'

interface AnalyticsDialogProps {
  open: boolean
  onClose: () => void
}

/** 集計期間のプリセット。0は全期間 */
const PERIODS = [
  { label: '過去7日', days: 7 },
  { label: '過去30日', days: 30 },
  { label: '全期間', days: 0 },
] as const

type TabKey = 'unanswered' | 'themes' | 'manuals'

// shortLabel は狭い画面用。3つ分の見出しをそのまま並べると横にはみ出し、
// 3つ目のタブが画面の外に出てしまうため
const TABS: {
  key: TabKey
  label: string
  shortLabel: string
  icon: React.ReactNode
}[] = [
  {
    key: 'unanswered',
    label: '答えられなかった質問',
    shortLabel: '未回答',
    icon: <LuCircleHelp />,
  },
  {
    key: 'themes',
    label: 'よく聞かれること',
    shortLabel: 'よくある質問',
    icon: <LuTrendingUp />,
  },
  {
    key: 'manuals',
    label: 'マニュアルの使われ方',
    shortLabel: 'マニュアル',
    icon: <LuFileText />,
  },
]

/** 取得に失敗したときの表示。黙って空欄になると「0件」と読み違える */
function ErrorNote({ error }: { error?: { message: string } }) {
  if (!error) return null
  return (
    <Text fontSize="sm" color="fg.error" mt={2}>
      読み込めませんでした: {error.message}
    </Text>
  )
}

/** 日時を「8/15 14:03」の形にする */
function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 利用状況を見る画面(ADMIN専用)。
 *
 * 「マニュアルが足りていない領域」を見つけるためのもので、
 * 答えられなかった質問・よく聞かれること・使われていないマニュアルを並べる。
 * 誰が質問したかは扱わない(内容だけを集計する)
 */
export function AnalyticsDialog({ open, onClose }: AnalyticsDialogProps) {
  const [days, setDays] = useState<number>(30)
  const [tab, setTab] = useState<TabKey>('unanswered')
  // マニュアルの下書き。質問を押した時点で作り始め、できたら画面に出す
  const [draftFor, setDraftFor] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftSources, setDraftSources] = useState<{ title: string }[]>([])
  const [draftManual, { loading: drafting }] = useMutation(
    DRAFT_MANUAL_MUTATION,
  )

  /** 答えられなかった質問から下書きを作る(押した操作から始める) */
  const makeDraft = async (question: string) => {
    setDraftFor(question)
    setDraft('')
    setDraftSources([])
    try {
      const { data } = await draftManual({ variables: { question } })
      if (!data) return
      setDraft(data.draftManual.draft)
      setDraftSources(data.draftManual.sources)
    } catch (e) {
      toastError('下書きを作れませんでした', errorMessage(e, ''))
      setDraftFor(null)
    }
  }
  // 期間が0(全期間)のときはサーバへnullを渡す
  const variables = { days: days === 0 ? null : days }

  const { data: summaryData } = useQuery(ANALYTICS_SUMMARY_QUERY, {
    skip: !open,
    variables,
    fetchPolicy: 'cache-and-network',
  })
  const {
    data: unansweredData,
    loading: unansweredLoading,
    error: unansweredError,
  } = useQuery(UNANSWERED_QUESTIONS_QUERY, {
    skip: !open || tab !== 'unanswered',
    variables,
    // 全体像と同じ取得方針にしないと、期間を戻したときに
    // ヘッダの数字だけ最新・一覧は古いキャッシュ、という食い違いが起きる
    fetchPolicy: 'cache-and-network',
  })
  const {
    data: usageData,
    loading: usageLoading,
    error: usageError,
  } = useQuery(MANUAL_USAGE_QUERY, {
    skip: !open || tab !== 'manuals',
    variables,
    fetchPolicy: 'cache-and-network',
  })
  // テーマ分けはAIを呼ぶので、押されたときだけ実行する
  const [
    fetchThemes,
    { data: themesData, loading: themesLoading, error: themesError },
  ] = useLazyQuery(QUESTION_THEMES_QUERY, { fetchPolicy: 'network-only' })
  // どの期間で数えた結果かを覚えておく。期間を変えたまま古い集計を
  // 出し続けると、画面の期間と数字が食い違って読み間違える
  const [themesDays, setThemesDays] = useState<number | null>(null)
  // ダイアログは開いたままマウントされ続けるので、開き直したときは
  // 前回の集計を持ち越さない(数日前の数字を今のものと思わせない)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setThemesDays(null)
  }

  const summary = summaryData?.analyticsSummary
  const unanswered = unansweredData?.unansweredQuestions ?? []
  const usage = usageData?.manualUsage ?? []
  const themes =
    themesDays === days ? (themesData?.questionThemes ?? []) : []
  const neverCited = usage.filter((u) => u.citedCount === 0)

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && onClose()}
      // 狭い画面では全画面にする(横がはみ出して読めなくなるため)
      size={{ base: 'full', md: 'xl' }}
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>利用状況</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              {/* 期間の切り替え */}
              <HStack gap={2} mb={3} flexWrap="wrap">
                {PERIODS.map((p) => (
                  <Button
                    key={p.days}
                    size="xs"
                    variant={days === p.days ? 'solid' : 'outline'}
                    colorPalette="blue"
                    onClick={() => setDays(p.days)}
                  >
                    {p.label}
                  </Button>
                ))}
              </HStack>

              {/* 全体像。可否を判定した分を上の行に、判定していない分は
                  理由ごとに下の行へ分けて出す。ひとまとめの「未判定」にすると、
                  対象外(聞き返し・管理操作)が大半なのか、仕組みが働いて
                  いないのかが画面から区別できない */}
              {summary && (
                <VStack
                  gap={1}
                  mb={4}
                  p={3}
                  borderWidth="1px"
                  borderRadius="md"
                  align="stretch"
                >
                  <HStack gap={4} flexWrap="wrap" fontSize="sm">
                    <Text>
                      質問 <b>{summary.questionCount}</b> 件
                    </Text>
                    <Text color="green.fg">
                      答えられた <b>{summary.answeredCount}</b>
                    </Text>
                    <Text color="orange.fg">
                      答えられなかった <b>{summary.unansweredCount}</b>
                    </Text>
                  </HStack>
                  <HStack gap={3} flexWrap="wrap" fontSize="xs" color="fg.subtle">
                    <Text>
                      対象外 {summary.outOfScopeCount}
                      <Text as="span" color="fg.subtle">
                        （聞き返し・管理操作）
                      </Text>
                    </Text>
                    {summary.failedCount > 0 && (
                      <Text color="red.fg">生成失敗 {summary.failedCount}</Text>
                    )}
                    {summary.unreportedCount > 0 && (
                      <Text>判定漏れ {summary.unreportedCount}</Text>
                    )}
                    {summary.notRecordedCount > 0 && (
                      <Text>記録前 {summary.notRecordedCount}</Text>
                    )}
                  </HStack>
                  {/* 人が押した評価。AIの自己申告より確かなので、
                      上の「答えられた/答えられなかった」でも優先している */}
                  {summary.ratedGoodCount + summary.ratedBadCount > 0 && (
                    <HStack gap={3} fontSize="xs" color="fg.muted">
                      <Text>
                        利用者の評価 👍 {summary.ratedGoodCount} ・ 👎{' '}
                        {summary.ratedBadCount}
                      </Text>
                    </HStack>
                  )}
                  <Text fontSize="xs" color="fg.muted">
                    この期間に一度も引用されていないマニュアル{' '}
                    <b>{summary.neverCitedManualCount}</b> 件
                  </Text>
                </VStack>
              )}

              {/* タブ */}
              <HStack gap={0} mb={3} borderBottomWidth="1px">
                {TABS.map((t) => (
                  <Button
                    key={t.key}
                    size="sm"
                    variant="ghost"
                    // 狭い画面では3つで幅を分け合う(横にはみ出さない)。
                    // PCはこれまで通り文字の長さぶんだけ
                    flex={{ base: '1', md: 'initial' }}
                    minW={0}
                    px={{ base: 1, md: 3 }}
                    borderBottomWidth="2px"
                    borderRadius={0}
                    borderColor={tab === t.key ? 'blue.solid' : 'transparent'}
                    color={tab === t.key ? 'fg' : 'fg.muted'}
                    onClick={() => setTab(t.key)}
                  >
                    {t.icon}
                    <Box as="span" hideBelow="md">
                      {t.label}
                    </Box>
                    <Box as="span" hideFrom="md" truncate>
                      {t.shortLabel}
                    </Box>
                  </Button>
                ))}
              </HStack>

              {/* 答えられなかった質問 */}
              {tab === 'unanswered' && (
                <VStack gap={2} align="stretch">
                  <Text fontSize="xs" color="fg.subtle">
                    利用者が👎を押した質問と、AIが「マニュアルに根拠が無い」と
                    判断した質問です。
                    ここに並ぶ内容が、次に用意すべきマニュアルの候補になります。
                  </Text>
                  {unansweredLoading && <Spinner size="sm" />}
                  <ErrorNote error={unansweredError} />
                  {!unansweredLoading && !unansweredError && unanswered.length === 0 && (
                    <Text fontSize="sm" color="fg.muted" mt={4}>
                      この期間に、答えられなかった質問はありません。
                    </Text>
                  )}
                  {unanswered.map((q) => (
                    <Box
                      key={q.id}
                      p={3}
                      borderWidth="1px"
                      borderRadius="md"
                      borderLeftWidth="3px"
                      borderLeftColor="orange.solid"
                    >
                      <HStack gap={2} align="flex-start">
                        <Text
                          fontSize="sm"
                          fontWeight="medium"
                          overflowWrap="anywhere"
                          flex="1"
                          minW={0}
                        >
                          {q.question}
                        </Text>
                        {/* 人が👎を押したものは、AIの判定より確かな手がかり */}
                        {q.ratedBad && (
                          <Badge colorPalette="orange" flexShrink={0}>
                            👎 利用者の評価
                          </Badge>
                        )}
                      </HStack>
                      {q.feedbackReason && (
                        <Text fontSize="xs" color="orange.fg" mt={1}>
                          理由: {q.feedbackReason}
                        </Text>
                      )}
                      <Text fontSize="xs" color="fg.muted" mt={1} overflowWrap="anywhere">
                        AIの回答: {q.answer.slice(0, 120)}
                        {q.answer.length > 120 && '…'}
                      </Text>
                      <HStack mt={2} gap={2} justify="space-between">
                        <Text fontSize="xs" color="fg.subtle">
                          {formatWhen(q.askedAt)}
                        </Text>
                        {/* 「足りない」と分かっただけでは埋まらない。
                            その場から書き始められるようにする */}
                        <Button
                          size="2xs"
                          variant="outline"
                          loading={drafting && draftFor === q.question}
                          onClick={() => void makeDraft(q.question)}
                        >
                          <LuFilePen /> この質問から下書きを作る
                        </Button>
                      </HStack>
                    </Box>
                  ))}
                </VStack>
              )}

              {/* よく聞かれること(AIでまとめる) */}
              {tab === 'themes' && (
                <VStack gap={2} align="stretch">
                  <Text fontSize="xs" color="fg.subtle">
                    言い回しが違うだけの質問をAIがまとめて数えます。
                    多いものは定型文に登録しておくと、毎回入力せずに済みます。
                  </Text>
                  <Box>
                    <Button
                      size="xs"
                      colorPalette="purple"
                      loading={themesLoading}
                      onClick={() => {
                        setThemesDays(days)
                        // 失敗はthemesErrorとして画面に出るので、
                        // ここでは未処理の拒否にならないよう受け止めるだけ
                        fetchThemes({ variables }).catch(() => undefined)
                      }}
                    >
                      <LuSparkles />
                      {themes.length > 0 ? 'もう一度まとめる' : 'AIでまとめる'}
                    </Button>
                  </Box>
                  <ErrorNote error={themesError} />
                  {!themesLoading && !themesError && themes.length === 0 && (
                    <Text fontSize="sm" color="fg.muted" mt={4}>
                      「AIでまとめる」を押すと、この期間の質問をテーマごとに数えます。
                    </Text>
                  )}
                  {themes.map((t) => (
                    <HStack
                      key={t.theme}
                      p={3}
                      borderWidth="1px"
                      borderRadius="md"
                      align="flex-start"
                      gap={3}
                    >
                      <Badge colorPalette="purple" flexShrink={0}>
                        {t.count}件
                      </Badge>
                      <Box flex="1" minW={0}>
                        <Text fontSize="sm" fontWeight="medium" overflowWrap="anywhere">
                          {t.theme}
                        </Text>
                        {t.examples.length > 0 && (
                          <Text fontSize="xs" color="fg.muted" mt={1} overflowWrap="anywhere">
                            例: {t.examples.join(' / ')}
                          </Text>
                        )}
                      </Box>
                    </HStack>
                  ))}
                </VStack>
              )}

              {/* マニュアルの使われ方 */}
              {tab === 'manuals' && (
                <VStack gap={2} align="stretch">
                  <Text fontSize="xs" color="fg.subtle">
                    回答の根拠として使われた回数です。0回が続くマニュアルは、
                    内容が古い・探しにくい・そもそも不要、のいずれかを疑えます。
                  </Text>
                  {usageLoading && <Spinner size="sm" />}
                  <ErrorNote error={usageError} />
                  {!usageLoading && !usageError && usage.length === 0 && (
                    <Text fontSize="sm" color="fg.muted" mt={4}>
                      表示できるマニュアルがありません。
                    </Text>
                  )}
                  {usage.length > 0 && (
                    <>
                      <HStack
                        px={2}
                        py={1}
                        gap={2}
                        borderBottomWidth="1px"
                        color="fg.muted"
                        fontSize="xs"
                      >
                        <Text flex="1">マニュアル</Text>
                        <Text w="70px" textAlign="right">
                          引用
                        </Text>
                        <Text w="80px" textAlign="right">
                          最終引用
                        </Text>
                      </HStack>
                      {usage.map((m) => (
                        <HStack
                          key={m.manualId}
                          px={2}
                          py={1.5}
                          gap={2}
                          borderBottomWidth="1px"
                          borderColor="border.subtle"
                        >
                          <Box flex="1" minW={0}>
                            <Text fontSize="sm" overflowWrap="anywhere">
                              {m.title}
                            </Text>
                            <Text fontSize="xs" color="fg.subtle">
                              {m.categoryName ?? '未分類'}
                            </Text>
                          </Box>
                          <Text
                            w="70px"
                            textAlign="right"
                            fontSize="sm"
                            color={m.citedCount === 0 ? 'fg.subtle' : 'fg'}
                            fontWeight={m.citedCount > 0 ? 'medium' : undefined}
                          >
                            {m.citedCount}回
                          </Text>
                          <Text
                            w="80px"
                            textAlign="right"
                            fontSize="xs"
                            color="fg.muted"
                          >
                            {formatWhen(m.lastCitedAt)}
                          </Text>
                        </HStack>
                      ))}
                      {neverCited.length > 0 && (
                        <Text fontSize="xs" color="fg.subtle" mt={2}>
                          この期間に一度も使われていないマニュアルが
                          {neverCited.length}件あります。
                        </Text>
                      )}
                    </>
                  )}
                </VStack>
              )}
            </Dialog.Body>

            {/* 下書きの作成。利用状況を開いたまま作れるようにする */}
            <ManualDraftDialog
              question={draftFor}
              draft={draft}
              sources={draftSources}
              loading={drafting}
              onDraftChange={setDraft}
              onRegenerate={() => draftFor && void makeDraft(draftFor)}
              onClose={() => setDraftFor(null)}
            />

            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>
                閉じる
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
