import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  Heading,
  HStack,
  IconButton,
  Input,
  Image,
  Spinner,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { useEffect, useRef, useState } from 'react'
import { FcFile } from 'react-icons/fc'
import {
  LuCheck,
  LuCircleStop,
  LuCopy,
  LuExternalLink,
  LuArrowUp,
  LuImagePlus,
  LuMessageSquareText,
  LuPencil,
  LuThumbsDown,
  LuThumbsUp,
  LuX,
} from 'react-icons/lu'
import {
  CONVERSATION_QUERY,
  RATE_ANSWER_MUTATION,
  type ChatMessage,
  type MessageFeedback,
} from '../../graphql/chat'
import { ME_QUERY } from '../../graphql/me'
import { useIsTouchDevice } from '../../lib/useIsTouchDevice'
import { useSendKey } from '../../lib/settings'
import { askStream } from '../../lib/chatStream'
import { useManualViewer } from '../manual/manualViewerContext'
import { MarkdownText } from './MarkdownText'
import { splitLeadingIcon, withInlineIcons } from '../../lib/messageIcons'
import { PromptTemplateMenu } from './PromptTemplateMenu'
import { ImagePreview } from '../ui/ImagePreview'
import { Tooltip } from '../ui/Tooltip'
import { errorMessage, toastError } from '../../lib/toast'
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  fileToBase64,
  shrinkForUpload,
} from '../../lib/image'

interface ChatHomeProps {
  /** nullなら新規チャット。IDがあれば既存の会話を読み込んで続きから */
  conversationId: string | null
  /** 新規チャットの最初の回答が返り、会話がDBにできたときに呼ばれる */
  onConversationCreated: (id: string) => void
  /** 会話が見つからなかった(削除済み・他ユーザーのもの)ときに呼ばれる */
  onConversationNotFound?: () => void
}

// 表示用。imageUrlsは、送信直後は手元のプレビューURL、
// 会話を開き直したあとはサーバーが返す署名付きURLが入る
type LocalMessage = ChatMessage



// 引用をマニュアル単位にまとめる(同じマニュアルの複数ページを1カードに集約)
interface PageLink {
  page: number
  label: string // ページの見出し(チャンク先頭から推定した短いラベル)
  snippet: string // ホバー時のツールチップ用(もう少し長い抜粋)
}

interface CitationGroup {
  manualId: string
  title: string
  topPage: number | null // 最も関連度が高いページ(タイトルクリック時に開く)
  pages: PageLink[] // ページリンク一覧(昇順)
}

/** チャンク抜粋の先頭から「見出しらしき部分」を短く取り出す */
function pageLabel(snippet: string): string {
  const firstLine = snippet.split('\n')[0] ?? ''
  // 先頭の章番号や記号(「3 」「1.2 」「【」など)を落として本文の言葉から始める
  const cleaned = firstLine.replace(/^[\d\s.．)）\-【】#*]+/, '').trim()
  // 短すぎると「STEP5…」のように何の項目か分からないので、ある程度長めに見せる
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned
}

function groupCitations(
  citations: ChatMessage['citations'],
): CitationGroup[] {
  const groups: CitationGroup[] = []
  const byId = new Map<string, CitationGroup>()
  for (const citation of citations) {
    let group = byId.get(citation.manualId)
    if (!group) {
      group = {
        manualId: citation.manualId,
        title: citation.title,
        topPage: citation.pageNumber,
        pages: [],
      }
      byId.set(citation.manualId, group)
      groups.push(group)
    }
    if (
      citation.pageNumber != null &&
      !group.pages.some((p) => p.page === citation.pageNumber)
    ) {
      group.pages.push({
        page: citation.pageNumber,
        label: pageLabel(citation.snippet),
        snippet: citation.snippet,
      })
    }
  }
  for (const group of groups) group.pages.sort((a, b) => a.page - b.page)
  return groups
}

/** 1つの質問に添えられる画像の枚数(サーバー側の上限と合わせる) */
const MAX_IMAGES = 4

/**
 * 👎のときに選べる理由。
 *
 * 自由記述にすると書いてもらえないので、次の打ち手が変わる3つに絞る。
 * 「マニュアルが無い」なら作る、「内容が古い」なら差し替える、
 * 「欲しい答えと違う」なら検索や回答の作り方を見直す
 */
const BAD_REASONS = ['マニュアルが無い', '内容が古い', '欲しい答えと違う']

/** 発言時刻の表示。今日なら「14:32」、それ以外は「8/12 14:32」 */
function formatChatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}



/** AI検索のチャット画面。質問前は中央に検索欄、質問後はスレッド表示 */
export function ChatHome({
  conversationId,
  onConversationCreated,
  onConversationNotFound,
}: ChatHomeProps) {
  // 入力途中の内容を会話ごとの「下書き」として保存し、リロード後も復元する
  const draftKey = `manualSearch.draft.${conversationId ?? 'new'}`
  const [input, setInput] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? ''
    } catch {
      return ''
    }
  })
  useEffect(() => {
    try {
      if (input) localStorage.setItem(draftKey, input)
      else localStorage.removeItem(draftKey) // 送信・クリアしたら下書きも消す
    } catch {
      // ストレージが使えない環境では黙って諦める(機能自体は動く)
    }
  }, [input, draftKey])
  // サーバーに保存済みのメッセージ + 送信中の楽観的な表示をまとめて持つ
  const [messages, setMessages] = useState<LocalMessage[]>([])
  // 「〜を開始しました」で終わっている=裏で処理が走っていて、
  // 完了メッセージが後から届く状態(その間だけ会話を取り直す)
  const lastMessage = messages[messages.length - 1]
  const waitingForBackgroundJob =
    lastMessage?.role === 'ASSISTANT' &&
    lastMessage.content.includes('再分類を開始しました')
  // 添付中の画像(任意・複数可)。プレビュー用のURLも一緒に持つ
  const [attachedImages, setAttachedImages] = useState<
    { file: File; url: string }[]
  >([])
  // 選択肢の下に常設する「その他」インライン入力欄の内容
  const [otherText, setOtherText] = useState('')
  // コピー直後のフィードバック表示(✓)に使う。対象メッセージのIDを持つ
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // 拡大表示している画像。nullなら閉じている
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(
    null,
  )
  // 👎を押した直後に理由を聞く吹き出しを出す対象(メッセージID)
  const [askingReason, setAskingReason] = useState<string | null>(null)
  const [rateAnswer] = useMutation(RATE_ANSWER_MUTATION)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 送信中のリクエストを「停止」ボタンから中断するためのコントローラ
  const abortRef = useRef<AbortController | null>(null)
  // 設定: Enterで送信(既定) / Shift+Enterで送信
  const sendKey = useSendKey()
  const sendOnPlainEnter = sendKey === 'enter'
  const isTouch = useIsTouchDevice()
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastMessageRef = useRef<HTMLDivElement>(null)
  // 履歴を開いた直後かどうか(そのときだけ一番下へ即時ジャンプする)
  const justLoadedHistoryRef = useRef(false)

  // 既存の会話を開いた場合は履歴をDBから読み込む
  const {
    data: conversationData,
    loading: loadingHistory,
    error: conversationError,
  } = useQuery(CONVERSATION_QUERY, {
    variables: { id: conversationId ?? '' },
    skip: !conversationId,
    fetchPolicy: 'cache-and-network',
    // 再分類のような裏で走る処理は、完了メッセージが後から会話に書き込まれる。
    // 待っている間だけ会話を取り直して、開いたままでも結果が出るようにする
    pollInterval: waitingForBackgroundJob ? 5000 : 0,
  })
  const apolloClient = useApolloClient()
  useEffect(() => {
    if (conversationData) {
      justLoadedHistoryRef.current = true
      const messages = conversationData.conversation.messages
      setMessages(messages)
      // バックグラウンドの再分類が完了していたら、フォルダ/マニュアル一覧の
      // キャッシュを取り直す(完了メッセージは会話を開いたときに届くため)
      const last = messages[messages.length - 1]
      if (last?.role === 'ASSISTANT' && last.content.includes('再分類が完了')) {
        void apolloClient.refetchQueries({
          include: ['ManualCategories', 'Manuals'],
        })
      }
    }
  }, [conversationData, apolloClient])

  // 会話が見つからない(削除済み等)ならホームに戻してもらう
  useEffect(() => {
    if (conversationError && conversationId) {
      onConversationNotFound?.()
    }
  }, [conversationError, conversationId, onConversationNotFound])

  // 管理者はチャットからフォルダ作成・再分類ができるため、その結果を
  // カテゴリ一覧・マニュアル一覧(表示中のもの)にも反映する。一般ユーザーは
  // カテゴリが変わることがないので余計な再取得をしない
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  // 回答はGraphQLではなく専用の経路で受け取る(文字が届くたびに書き足すため)。
  // 送信中かどうかと、書き足し中の吹き出しは自分で持つ
  const [loading, setLoading] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  /** 書き足し中の吹き出しが既に出ているか(出ていれば「探しています」は不要) */
  const streamingStarted =
    streamingId !== null && messages.some((m) => m.id === streamingId)

  /** 回答後に一覧を最新化する(サイドバーの履歴、管理者はフォルダ一覧も) */
  const refetchAfterAnswer = () =>
    void apolloClient.refetchQueries({
      include: isAdmin
        ? ['Conversations', 'ManualCategories', 'Manuals']
        : ['Conversations'],
    })

  // 引用カードからアプリ内ビューアでPDFを開く
  const { openManual } = useManualViewer()

  // スクロール制御:
  // - 履歴を開いた直後: 一番下へ即時ジャンプ(続きから読む位置)
  // - 回答を書き足している最中: 文字を追いかけて一番下へ(アニメ無し)
  // - AIの回答が出そろった: 回答の「先頭」に合わせる(長い回答を頭から読めるように)
  // - それ以外(自分の送信・考え中): 一番下へ
  useEffect(() => {
    if (justLoadedHistoryRef.current) {
      justLoadedHistoryRef.current = false
      bottomRef.current?.scrollIntoView() // 履歴表示はアニメ無しで一気に
      return
    }
    if (streamingStarted) {
      // 1文字ごとに滑らかスクロールを掛けると追従が間に合わず画面が揺れる
      bottomRef.current?.scrollIntoView()
      return
    }
    const last = messages[messages.length - 1]
    if (!loading && last?.role === 'ASSISTANT') {
      lastMessageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, loading, streamingStarted])

  /** 選ばれた画像を添付に足す(使えないものは理由を伝えて飛ばす) */
  const handleAttach = (files: File[]) => {
    if (files.length === 0) return
    const room = MAX_IMAGES - attachedImages.length
    if (room <= 0) {
      toastError(`画像は${MAX_IMAGES}枚までです`)
      return
    }
    const rejected: string[] = []
    const accepted: { file: File; url: string }[] = []
    for (const file of files.slice(0, room)) {
      if (!(file.type in ALLOWED_IMAGE_TYPES)) {
        rejected.push(`${file.name || '画像'}: PNG / JPEG / WebP / GIF のみ`)
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        rejected.push(`${file.name || '画像'}: 4MB以下にしてください`)
        continue
      }
      accepted.push({ file, url: URL.createObjectURL(file) })
    }
    if (rejected.length > 0) {
      toastError('添付できない画像がありました', rejected.join('\n'))
    }
    if (files.length > room) {
      toastError(
        `画像は${MAX_IMAGES}枚までです`,
        `${files.length - room}枚は添付していません`,
      )
    }
    if (accepted.length > 0) {
      setAttachedImages((prev) => [...prev, ...accepted])
    }
  }

  /** 添付を1枚だけ外す */
  const removeAttached = (index: number) => {
    setAttachedImages((prev) => {
      // プレビュー用に作ったURLは、外すときに開放する
      const target = prev[index]
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter((_, i) => i !== index)
    })
  }

  /**
   * 貼り付けからも画像を添付できるようにする。
   *
   * 画面を撮ってそのまま貼るのが一番早い。一度ファイルに保存させると手間が増え、
   * 「画像を見せて聞く」をしなくなってしまう。
   *
   * 入力欄に限らずチャット画面のどこで貼っても拾う。ただしダイアログ
   * (お問い合わせなど)が開いているときは、そちらの貼り付けを横取りしない。
   * 閉じているダイアログも中身はDOMに残っているので、開いているものだけを
   * 見る(data-state。単に役割で探すと、常に見送ってしまう)
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null)
      if (files.length === 0) return
      e.preventDefault() // 画像のファイル名などが本文に入らないように
      handleAttach(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  /**
   * 回答に👍/👎を付ける(同じものをもう一度押すと取り消し)。
   *
   * AIの自己申告だけでは「根拠はあるが知りたいことに答えていない」回答を
   * 拾えない。人の判断を記録して、利用状況の集計ではそちらを優先する。
   */
  const rate = async (message: LocalMessage, value: MessageFeedback) => {
    const next = message.feedback === value ? null : value
    const before = message.feedback ?? null
    // 押した瞬間に色を変える(通信の往復を待たせない)
    const apply = (feedback: MessageFeedback | null) =>
      setMessages((prev) =>
        prev.map((m) =>
          m.id === message.id
            ? {
                ...m,
                feedback,
                // 👎を外したら理由も消える
                feedbackReason: feedback === 'BAD' ? m.feedbackReason : null,
              }
            : m,
        ),
      )
    apply(next)
    setAskingReason(next === 'BAD' ? message.id : null)
    try {
      await rateAnswer({ variables: { messageId: message.id, feedback: next } })
    } catch (e) {
      apply(before) // 送れなかったら元に戻す(押せたように見せない)
      setAskingReason(null)
      toastError('評価を送れませんでした', errorMessage(e, ''))
    }
  }

  /** 👎の理由を送る(任意。選ばなくてもよい) */
  const sendReason = async (message: LocalMessage, reason: string) => {
    setAskingReason(null)
    setMessages((prev) =>
      prev.map((m) =>
        m.id === message.id ? { ...m, feedbackReason: reason } : m,
      ),
    )
    try {
      await rateAnswer({
        variables: { messageId: message.id, feedback: 'BAD', reason },
      })
    } catch {
      // 理由は付け足しなので、送れなくても評価そのものは残す
    }
  }

  /** 質問を送る。入力欄からの送信・選択肢ボタン・その他入力のすべてから使う */
  const send = async (rawQuestion: string) => {
    // 画像だけでも送れるようにする(質問文が無いときは既定の問いかけを補う。
    // 履歴が空欄にならず、AIにも「画像について聞かれている」と伝わる)
    const question =
      rawQuestion ||
      (attachedImages.length > 0
        ? attachedImages.length === 1
          ? 'この画像について教えてください'
          : 'これらの画像について教えてください'
        : '')
    if (!question || loading) return
    const images = attachedImages
    setInput('')
    // URLは吹き出しの表示に使い続けるので、ここでは開放しない
    setAttachedImages([])
    setOtherText('')

    // まず自分の発言を即表示(楽観的更新)。IDは仮でよい
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: 'USER',
        content: question,
        citations: [],
        options: [],
        feedback: null,
        feedbackReason: null,
        createdAt: new Date().toISOString(),
        imageUrls: images.map((i) => i.url),
      },
    ])

    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    // 回答を書き足していく吹き出しのID。届いた文字をここに足していく
    const streamId = `stream-${Date.now()}`
    setStreamingId(streamId)
    try {
      const result = await askStream({
        question,
        conversationId,
        // 送る前に長辺1600px・品質85まで落とす。ここで縮めないと
        // 1枚4MB×4枚=16MB(base64で21MB)がそのままbackendとragへ流れる。
        // 縮められなかったものは元のまま渡す(質問ごと落とさない)
        images: await Promise.all(
          images.map(async (i) => {
            const file = await shrinkForUpload(i.file)
            return {
              base64: await fileToBase64(file),
              format: ALLOWED_IMAGE_TYPES[file.type],
            }
          }),
        ),
        // 「停止」ボタンで接続ごと中断できるようにする
        signal: controller.signal,
        onDelta: (text) =>
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last?.id === streamId) {
              // 既に出ている吹き出しに書き足す
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + text },
              ]
            }
            return [
              ...prev,
              {
                id: streamId,
                role: 'ASSISTANT',
                content: text,
                citations: [],
                options: [],
                imageUrls: [],
                feedback: null,
                feedbackReason: null,
                createdAt: new Date().toISOString(),
              },
            ]
          }),
        // 管理操作などで本文が差し替わるときは、途中経過を消してやり直す
        onReset: () =>
          setMessages((prev) =>
            prev[prev.length - 1]?.id === streamId ? prev.slice(0, -1) : prev,
          ),
      })
      // 確定した回答で置き換える(引用・選択肢もここで付く)
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== streamId),
        result.message,
      ])
      // 新規チャットだった場合、できあがった会話IDをAppに知らせる
      if (!conversationId) {
        onConversationCreated(result.conversationId)
      }
      refetchAfterAnswer()
    } catch (e) {
      // 途中まで出ていた回答は確定していないので消す
      setMessages((prev) => prev.filter((m) => m.id !== streamId))
      // 停止ボタンによる中断はエラー扱いにしない。
      // 接続を切るとサーバー側も生成を打ち切り、質問ごと保存を取り消すので、
      // 「保存されていない」ことを短い一文で案内する
      if (controller.signal.aborted) {
        setMessages((prev) => [
          ...prev,
          {
            id: `local-stop-${Date.now()}`,
            role: 'ASSISTANT',
            content:
              '⏹ 回答を停止しました。この質問は保存されていません。質問の編集ボタン(鉛筆マーク)から編集して再送信できます。',
            citations: [],
            options: [],
            imageUrls: [],
            feedback: null,
            feedbackReason: null,
            createdAt: new Date().toISOString(),
          },
        ])
        return
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          role: 'ASSISTANT',
          content: `エラーが発生しました: ${e instanceof Error ? e.message : '不明なエラー'}`,
          citations: [],
          options: [],
          imageUrls: [],
          feedback: null,
          feedbackReason: null,
          createdAt: new Date().toISOString(),
        },
      ])
    } finally {
      abortRef.current = null
      setStreamingId(null)
      setLoading(false)
    }
  }

  const handleSubmit = () => void send(input.trim())

  /** メッセージ本文をクリップボードへ(ドラッグ選択せずにコピーできるように) */
  const copyMessage = async (message: LocalMessage) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedId(message.id)
      setTimeout(
        () => setCopiedId((prev) => (prev === message.id ? null : prev)),
        1500,
      )
    } catch {
      toastError('コピーできませんでした')
    }
  }

  /**
   * テンプレートを入力欄に差し込む。
   * 「〇〇」が含まれていればそこを選択状態にして、すぐ書き換えられるようにする
   */
  const insertTemplate = (body: string) => {
    setInput(body)
    const placeholder = body.indexOf('〇〇')
    // stateの反映後にカーソルを動かす必要があるので次のフレームで実行する
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      if (placeholder >= 0) {
        textarea.setSelectionRange(placeholder, placeholder + 2)
      } else {
        textarea.setSelectionRange(body.length, body.length)
      }
    })
  }

  /** 送信済みの質問を入力欄へ戻す(編集して再送信するため) */
  const editMessage = (message: LocalMessage) => {
    // DB保存時に付く画像添付の目印は編集対象から外す
    setInput(message.content.replace(/\n\(📷 画像を\d*枚?添付\)$/, ''))
    textareaRef.current?.focus()
  }

  const searchInput = (
    <VStack w="100%" maxW="800px" gap={2} align="stretch">
      {/* 添付中の画像。ファイル名は出さず、絵そのものを小さく並べる。
          「何を添えたか」は絵を見れば分かるし、名前まで出すと1枚ごとに
          横幅を取って複数枚並べられない */}
      {attachedImages.length > 0 && (
        <HStack alignSelf="flex-start" gap={2} flexWrap="wrap" px={1} pt={1}>
          {attachedImages.map((item, index) => (
            <Box key={item.url} position="relative">
              {/* 押すと大きく見られる。送る前に「これで合っているか」を
                  確かめられるようにする */}
              <Image
                src={item.url}
                alt={`添付する画像${index + 1}(押すと拡大)`}
                boxSize="56px"
                objectFit="cover"
                borderRadius="lg"
                borderWidth="1px"
                cursor="zoom-in"
                _hover={{ opacity: 0.8 }}
                onClick={() =>
                  setPreview({
                    url: item.url,
                    label: item.file.name || `画像${index + 1}`,
                  })
                }
              />
              <IconButton
                aria-label={`${index + 1}枚目の添付を取り消す`}
                size="2xs"
                borderRadius="full"
                position="absolute"
                top="-6px"
                right="-6px"
                minW="20px"
                h="20px"
                bg="bg.inverted"
                color="fg.inverted"
                _hover={{ bg: 'bg.inverted', opacity: 0.85 }}
                onClick={() => removeAttached(index)}
              >
                <LuX />
              </IconButton>
            </Box>
          ))}
        </HStack>
      )}

      {/* スマホでは全体をひと回り小さくする。ボタンが大きいままだと
          入力欄に残る幅が狭くなり、行が膨らんで画面を占領してしまう */}
      <HStack gap={{ base: 1, md: 2 }}>
        {/* 画像添付(スクリーンショットを添えて質問できる) */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: 'none' }}
          onChange={(e) => {
            handleAttach(Array.from(e.target.files ?? []))
            e.target.value = '' // 同じファイルを選び直せるように
          }}
        />
        {/* 定型文(テンプレート)。選ぶと入力欄に入り、〇〇が選択状態になる */}
        <PromptTemplateMenu onSelect={insertTemplate}>
          <Tooltip label="よく使う質問から選ぶ">
            <IconButton
              aria-label="よく使う質問から選ぶ"
              size={{ base: 'md', md: 'lg' }}
              variant="outline"
              borderRadius="full"
              color="fg.muted"
              alignSelf="flex-end"
            >
              <LuMessageSquareText />
            </IconButton>
          </Tooltip>
        </PromptTemplateMenu>
        <Tooltip
          label={
            attachedImages.length >= MAX_IMAGES
              ? `画像は${MAX_IMAGES}枚までです`
              : '画像を添付（貼り付けでも添えられます）'
          }
        >
          <IconButton
            aria-label="画像を添付"
            disabled={attachedImages.length >= MAX_IMAGES}
            size={{ base: 'md', md: 'lg' }}
            variant="outline"
            borderRadius="full"
            fontSize={{ base: 'lg', md: 'xl' }}
            color="fg.muted"
            alignSelf="flex-end" // 入力欄が伸びても下端に揃える
            onClick={() => fileInputRef.current?.click()}
          >
            <LuImagePlus />
          </IconButton>
        </Tooltip>
        <Textarea
          ref={textareaRef}
          size={{ base: 'md', md: 'lg' }}
          rows={1}
          autoresize // 入力量に応じて高さが自動で伸びる
          maxH="10em" // 伸びすぎ防止(超えたら内部スクロール)
          // スマホでは短い文言にする。画面が狭いところに長い例文を入れると
          // 折り返して入力欄が何行にも膨らみ、送信キーの案内も
          // (Shiftキーが無いので)意味がない
          placeholder={
            isTouch
              ? '例: マニュアルを見せて'
              : sendOnPlainEnter
                ? '例: クイックパーツマニュアルを見せて（Shift+Enterで改行）'
                : '例: クイックパーツマニュアルを見せて（Shift+Enterで送信）'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 日本語変換の確定Enterは無視。送信キーは設定で切り替え可能
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            const shouldSend = sendOnPlainEnter ? !e.shiftKey : e.shiftKey
            if (shouldSend) {
              e.preventDefault() // 送信時に改行が入らないように
              handleSubmit()
            }
          }}
        />
        {/* 送るボタンは文字を置かず、丸い矢印にする。AIとの対話画面で
            見慣れた形なので一目で分かり、その分の幅を入力欄に回せる */}
        {loading ? (
          // 送信中は「停止」に切り替える(待たされ続けないための逃げ道)
          <Tooltip label="停止">
            <IconButton
              aria-label="停止"
              size={{ base: 'md', md: 'lg' }}
              colorPalette="red"
              variant="outline"
              borderRadius="full"
              onClick={() => abortRef.current?.abort()}
              alignSelf="flex-end"
            >
              <LuCircleStop />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip label="検索">
            <IconButton
              aria-label="検索"
              size={{ base: 'md', md: 'lg' }}
              colorPalette="blue"
              borderRadius="full"
              onClick={handleSubmit}
              // 文章が無くても画像が添付されていれば送れる
              disabled={!input.trim() && attachedImages.length === 0}
              alignSelf="flex-end" // 入力欄が伸びてもボタンは下端に揃える
            >
              <LuArrowUp />
            </IconButton>
          </Tooltip>
        )}
      </HStack>

      {/* 画像の拡大表示。添付中のものも、送信済みのものもここから開く
          (入力欄は新規チャットでもスレッドでも出るので、置き場所はここ1つでよい) */}
      <ImagePreview
        src={preview?.url ?? null}
        label={preview?.label}
        onClose={() => setPreview(null)}
      />
    </VStack>
  )

  // 質問前(新規チャット): 中央に大きく検索欄(ChatGPT風の空状態)
  if (messages.length === 0 && !loadingHistory) {
    return (
      <VStack
        h="100%"
        justify="center"
        gap={{ base: 4, md: 6 }}
        px={{ base: 3, md: 4 }}
        pt={{ base: 12, md: 0 }}
      >
        <Heading size={{ base: 'xl', md: '2xl' }}>Manualy</Heading>
        {/* 折り返すと2行になって見出しとの間が間延びするので、
            一番狭い画面でも1行に収まる長さにしてある(全角20文字) */}
        <Text
          color="fg.muted"
          fontSize={{ base: 'sm', md: 'md' }}
          textAlign="center"
          whiteSpace="nowrap"
        >
          知りたいことを入力すると、AIが案内します
        </Text>
        {searchInput}
      </VStack>
    )
  }

  // スレッド表示 + 下部に入力欄
  return (
    <VStack h="100%" gap={0}>
      <Box
        flex="1"
        w="100%"
        overflowY="auto"
        // 縦だけautoにすると横は自動でautoになり、はみ出した瞬間に
        // スレッド全体が横スクロールしてしまうので明示的に抑える
        overflowX="hidden"
        px={4}
        py={6}
        pt={{ base: 14, md: 6 }}
      >
        <VStack maxW="800px" mx="auto" gap={4} align="stretch">
          {loadingHistory && <Spinner alignSelf="center" />}

          {messages.map((message, index) => (
            <Box
              key={message.id}
              ref={index === messages.length - 1 ? lastMessageRef : undefined}
              style={{ scrollMarginTop: '12px' }} // 先頭に合わせた時に少し余白を残す
              alignSelf={message.role === 'USER' ? 'flex-end' : 'flex-start'}
              bg={message.role === 'USER' ? 'blue.solid' : 'bg.muted'}
              color={message.role === 'USER' ? 'blue.contrast' : 'fg'}
              px={4}
              py={2}
              borderRadius="lg"
              maxW="85%"
              minW={0}
              // 区切りの無い長文でも吹き出しの外へ出さない
              // (継承されるので中の本文・選択肢・引用にも効く)
              overflowWrap="anywhere"
            >
              {/* 送信時に添付した画像(このセッション中のみ表示) */}
              {message.imageUrls && message.imageUrls.length > 0 && (
                <HStack gap={1} flexWrap="wrap" mb={2}>
                  {message.imageUrls.map((url, i) => (
                    <Image
                      key={url}
                      src={url}
                      alt={`添付画像${i + 1}(押すと拡大)`}
                      maxH="160px"
                      maxW="100%"
                      borderRadius="md"
                      cursor="zoom-in"
                      _hover={{ opacity: 0.8 }}
                      onClick={() => setPreview({ url, label: `画像${i + 1}` })}
                    />
                  ))}
                </HStack>
              )}
              {/* AIの回答はMarkdownを整形表示、ユーザーの発言はそのまま */}
              {message.role === 'ASSISTANT' ? (
                <MarkdownText>{message.content}</MarkdownText>
              ) : (
                <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                  {withInlineIcons(message.content)}
                </Text>
              )}

              {/* 絞り込み質問の選択肢。クリックがそのまま回答になる */}
              {message.options.length > 0 && (
                <VStack mt={3} gap={2} align="stretch">
                  {message.options.map((option, i) => (
                    <Button
                      key={i}
                      size="sm"
                      variant="outline"
                      colorPalette="blue"
                      bg="bg.panel"
                      justifyContent="flex-start"
                      whiteSpace="normal"
                      h="auto"
                      py={2}
                      disabled={loading}
                      onClick={() => void send(option)}
                    >
                      {/* 「✅ はい」のような先頭の絵文字はアイコンで見せる。
                          送信する値(option)は変えない(サーバー側が文字列で照合するため) */}
                      {(() => {
                        const split = splitLeadingIcon(option)
                        return split ? (
                          <>
                            {split.icon}
                            {split.rest}
                          </>
                        ) : (
                          option
                        )
                      })()}
                    </Button>
                  ))}
                  {/* どれにも当てはまらない人向け: 常設のインライン入力欄
                      (最新のメッセージにだけ表示) */}
                  {index === messages.length - 1 && (
                    <HStack gap={2}>
                      <Input
                        size="sm"
                        bg="bg.panel"
                        placeholder={
                          isTouch
                            ? 'その他'
                            : sendOnPlainEnter
                              ? 'その他（自由に入力してEnterで送信）'
                              : 'その他（自由に入力してShift+Enterで送信）'
                        }
                        value={otherText}
                        onChange={(e) => setOtherText(e.target.value)}
                        onKeyDown={(e) => {
                          // 一行入力だが、送信キーの操作感はメイン入力欄と揃える
                          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                          if (!sendOnPlainEnter && !e.shiftKey) return
                          void send(otherText.trim())
                        }}
                      />
                      <Button
                        size="sm"
                        colorPalette="blue"
                        variant="outline"
                        disabled={!otherText.trim() || loading}
                        onClick={() => void send(otherText.trim())}
                      >
                        送信
                      </Button>
                    </HStack>
                  )}
                </VStack>
              )}

              {/* 根拠マニュアル(引用)。マニュアル単位に1カード、ページはリンクで並べる */}
              {message.citations.length > 0 && (
                <VStack mt={2} gap={1} align="stretch">
                  {groupCitations(message.citations).map((group) => (
                    <Box
                      key={group.manualId}
                      fontSize="sm"
                      bg="bg.panel"
                      borderRadius="md"
                      px={3}
                      py={2}
                    >
                      <HStack
                        gap={1}
                        fontWeight="medium"
                        color="blue.fg"
                        cursor="pointer"
                        _hover={{ textDecoration: 'underline' }}
                        onClick={() =>
                          openManual(group.manualId, group.title, group.topPage)
                        }
                      >
                        {/* 長いマニュアル名でもカードからはみ出さないよう、
                            アイコンは縮めず名前側だけを折り返す */}
                        <Box flexShrink={0} display="inline-flex">
                          <FcFile />
                        </Box>
                        <Text minW={0} overflowWrap="anywhere">
                          {group.title}
                        </Text>
                        <Box flexShrink={0} display="inline-flex">
                          <LuExternalLink size={12} />
                        </Box>
                      </HStack>
                      {group.pages.length > 0 && (
                        <HStack mt={1} gap={1} flexWrap="wrap">
                          {group.pages.map(({ page, label, snippet }) => (
                            <Button
                              key={page}
                              size="2xs"
                              variant="outline"
                              colorPalette="blue"
                              title={snippet} // ホバーで抜粋の続きが見える
                              onClick={() =>
                                openManual(group.manualId, group.title, page)
                              }
                            >
                              p.{page}
                              {label && (
                                <Text as="span" fontWeight="normal" ms={1}>
                                  {label}
                                </Text>
                              )}
                            </Button>
                          ))}
                        </HStack>
                      )}
                    </Box>
                  ))}
                </VStack>
              )}

              {/* メッセージ操作: 発言時刻 + コピー / (質問のみ)編集して再送信 */}
              <HStack mt={1} gap={0} justify="flex-end" align="center">
                <Text
                  fontSize="2xs"
                  me="auto"
                  pe={3}
                  opacity={0.75}
                  color={message.role === 'USER' ? 'blue.contrast' : 'fg.muted'}
                >
                  {formatChatTime(message.createdAt)}
                </Text>
                <Tooltip label="コピー">
                  <IconButton
                    aria-label="コピー"
                    size="2xs"
                    variant="ghost"
                    color={
                      message.role === 'USER' ? 'blue.contrast' : 'fg.muted'
                    }
                    onClick={() => void copyMessage(message)}
                  >
                    {copiedId === message.id ? <LuCheck /> : <LuCopy />}
                  </IconButton>
                </Tooltip>
                {message.role === 'USER' && (
                  <Tooltip label="編集して再送信">
                    <IconButton
                      aria-label="編集して再送信"
                      size="2xs"
                      variant="ghost"
                      color="blue.contrast"
                      onClick={() => editMessage(message)}
                    >
                      <LuPencil />
                    </IconButton>
                  </Tooltip>
                )}
                {/* 回答の評価。書き足し中の吹き出しにはまだIDが無いので出さない */}
                {message.role === 'ASSISTANT' &&
                  message.id !== streamingId && (
                    <>
                      <Tooltip label="役に立った">
                        <IconButton
                          aria-label="役に立った"
                          size="2xs"
                          variant="ghost"
                          color={
                            message.feedback === 'GOOD'
                              ? 'green.fg'
                              : 'fg.muted'
                          }
                          onClick={() => void rate(message, 'GOOD')}
                        >
                          <LuThumbsUp />
                        </IconButton>
                      </Tooltip>
                      <Tooltip label="役に立たなかった">
                        <IconButton
                          aria-label="役に立たなかった"
                          size="2xs"
                          variant="ghost"
                          color={
                            message.feedback === 'BAD'
                              ? 'orange.fg'
                              : 'fg.muted'
                          }
                          onClick={() => void rate(message, 'BAD')}
                        >
                          <LuThumbsDown />
                        </IconButton>
                      </Tooltip>
                    </>
                  )}
              </HStack>

              {/* 👎の理由。任意なので、選ばなくても閉じられる。
                  何が足りないかで次にやること(作る・直す・書き足す)が変わる */}
              {askingReason === message.id && (
                <HStack mt={2} gap={1} flexWrap="wrap">
                  <Text fontSize="xs" color="fg.muted">
                    差し支えなければ理由を:
                  </Text>
                  {BAD_REASONS.map((reason) => (
                    <Button
                      key={reason}
                      size="2xs"
                      variant="outline"
                      onClick={() => void sendReason(message, reason)}
                    >
                      {reason}
                    </Button>
                  ))}
                  <IconButton
                    aria-label="閉じる"
                    size="2xs"
                    variant="ghost"
                    color="fg.muted"
                    onClick={() => setAskingReason(null)}
                  >
                    <LuX />
                  </IconButton>
                </HStack>
              )}
              {/* 選んだ理由は残しておく(あとから見て何が問題か分かるように) */}
              {message.feedbackReason && askingReason !== message.id && (
                <Text mt={1} fontSize="xs" color="fg.muted">
                  評価の理由: {message.feedbackReason}
                </Text>
              )}
            </Box>
          ))}

          {/* 検索している間だけ出す。文字が届き始めたら吹き出しが伸びていくので、
              くるくるは引っ込める(二重に「待っている」感を出さない) */}
          {loading && !streamingStarted && (
            <HStack alignSelf="flex-start" gap={2} color="fg.muted">
              <Spinner size="sm" />
              <Text fontSize="sm">マニュアルを探しています…</Text>
            </HStack>
          )}
          <div ref={bottomRef} />
        </VStack>
      </Box>

      <Box
        w="100%"
        borderTopWidth="1px"
        p={{ base: 2, md: 4 }}
        // ホーム画面から開いたときは画面の一番下まで表示領域になり、
        // ボタンがiPhoneのホームバーと重なって見切れる。
        // その分の余白を足す(重ならない端末では0なので何も変わらない)
        pb={{ base: 'calc(0.5rem + env(safe-area-inset-bottom))', md: '1rem' }}
        display="flex"
        justifyContent="center"
      >
        {searchInput}
      </Box>
    </VStack>
  )
}
