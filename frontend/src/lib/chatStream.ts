import type { ChatMessage } from '../graphql/chat'
import { getIdToken } from './auth'

/** ストリーミングの送り先。GraphQLと同じ場所の /chat/stream */
const STREAM_URL = (
  import.meta.env.VITE_GRAPHQL_URL ?? 'http://localhost:3000/graphql'
).replace(/\/graphql$/, '/chat/stream')

export interface AskStreamResult {
  conversationId: string
  message: ChatMessage
}

interface AskStreamParams {
  question: string
  conversationId?: string | null
  /** 質問に添えた画像(任意・複数可) */
  images?: { base64: string; format: string }[]
  signal: AbortSignal
  /** 文字が届くたびに呼ばれる(画面に足していく) */
  onDelta: (text: string) => void
  /** ここまでの途中経過を捨てる合図(管理操作や生成失敗で本文が差し替わるとき) */
  onReset: () => void
}

/**
 * 回答を少しずつ受け取りながら質問する。
 *
 * 完成を待たずに文字が届くので、体感の待ち時間が短くなる。
 * 保存される内容や戻り値はGraphQLのaskQuestionと同じで、
 * 最後に届く確定版で画面を置き換える。
 */
export async function askStream({
  question,
  conversationId,
  images,
  signal,
  onDelta,
  onReset,
}: AskStreamParams): Promise<AskStreamResult> {
  const token = getIdToken()
  const res = await fetch(STREAM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      question,
      conversationId: conversationId ?? null,
      images: images ?? [],
    }),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`回答を取得できませんでした (HTTP ${res.status})`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: AskStreamResult | null = null
  let failure: string | null = null

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSEは空行1つで1件の区切り
    let sep = buffer.indexOf('\n\n')
    while (sep !== -1) {
      const block = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const event = /^event: (\w+)$/m.exec(block)?.[1]
      const raw = /^data: (.*)$/m.exec(block)?.[1]
      if (event && raw) {
        const data = JSON.parse(raw) as Record<string, unknown>
        if (event === 'delta') onDelta(String(data.text ?? ''))
        else if (event === 'reset') onReset()
        else if (event === 'error') failure = String(data.message ?? '不明なエラー')
        else if (event === 'done') result = data as unknown as AskStreamResult
      }
      sep = buffer.indexOf('\n\n')
    }
  }

  if (failure) throw new Error(failure)
  if (!result) throw new Error('回答が途中で切れました')
  return result
}
