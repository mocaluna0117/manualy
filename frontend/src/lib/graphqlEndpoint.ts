/**
 * GraphQLの宛先(VITE_GRAPHQL_URL)が噛み合っているかを見るところ。
 *
 * 設定を読むのは lib/apollo.ts の仕事で、ここは渡された値を見て
 * 文言を作るだけにしてある(`node --test`で固定するため)。
 * ここには**副作用も外部importも置かない**。
 */

/** 通信の失敗と区別できるように名前を付ける(トーストの出し分けに使う) */
export const GRAPHQL_ENDPOINT_ERROR_NAME = 'GraphQLEndpointError'

/** 宛先そのものが違っていると分かっているときのエラー */
export class GraphQLEndpointError extends Error {
  constructor(message: string) {
    super(message)
    // ビルド後のクラス名は当てにならないので、名前は自分で入れる
    this.name = GRAPHQL_ENDPOINT_ERROR_NAME
  }
}

/** 絶対URL(http/https)か。相対パスなら配信元へ送られる */
export function isAbsoluteEndpoint(uri: string): boolean {
  return /^https?:\/\//i.test(uri)
}

/** 手元だけで届く宛先か(本番のビルドに混ざると誰からも届かない) */
export function isLocalEndpoint(uri: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(uri)
}

/**
 * 設定の組み合わせが噛み合っていないときの説明。噛み合っていればnull。
 *
 * **Cognito方式では何も言わない。** AWSはCloudFrontがフロントとAPIを
 * 同じオリジンにまとめているので、相対パスが正しい設定になる。
 *
 * Supabase方式は画面がCloudflare Pages、APIがCloud Runで**別のドメイン**
 * になる。ここで相対パスのままだと、Pagesのフォールバックが/graphqlにも
 * index.htmlを返し、ログインは成功したうえで中身が全部空のアプリが出る。
 * 実際に一度これが起きて「データが消えた」と受け取られている
 */
export function graphqlEndpointProblem({
  uri,
  useSupabaseAuth,
}: {
  uri: string
  useSupabaseAuth: boolean
}): string | null {
  if (!useSupabaseAuth) return null
  if (!isAbsoluteEndpoint(uri)) {
    return `認証はSupabaseなのに、GraphQLの宛先が相対パス(${uri})のままです。Cloudflare Pagesから配信するとAPIは別のドメイン(Cloud Run)になります。VITE_GRAPHQL_URL にCloud RunのURLを設定してビルドし直してください`
  }
  if (isLocalEndpoint(uri)) {
    return `認証はSupabaseなのに、GraphQLの宛先が手元向け(${uri})のままです。VITE_GRAPHQL_URL にCloud RunのURLを設定してビルドし直してください`
  }
  return null
}

/**
 * GraphQLの応答として受け取ってよい種別か。
 *
 * 素のJSONのほか、GraphQL over HTTPの application/graphql-response+json と、
 * 分割応答の multipart も通す。判定を厳しくしすぎると、正しい構成なのに
 * 全部の通信が止まってしまう
 */
export function isJsonLikeContentType(
  contentType: string | null | undefined,
): boolean {
  if (!contentType) return false
  const value = contentType.toLowerCase()
  return value.includes('json') || value.startsWith('multipart/')
}

/**
 * JSONでない応答が返ったときの文言。
 *
 * 素通しすると「Unexpected token '<'」で終わり、**どこへ送って何が
 * 返ったのかが一言も出ない。** 宛先と種別を必ず文言に入れる
 */
export function nonJsonResponseMessage(
  uri: string,
  status: number,
  contentType: string | null | undefined,
): string {
  const kind = contentType ? contentType.split(';')[0].trim() : '種別不明'
  const html = /html/i.test(contentType ?? '')
  const hint = html
    ? 'GraphQLではなく画面(index.html)が返っています。VITE_GRAPHQL_URL の設定を確認してください'
    : 'VITE_GRAPHQL_URL の設定と、APIが動いているかを確認してください'
  return `GraphQLの宛先(${uri})から${kind}が返りました(HTTP ${status})。${hint}`
}
