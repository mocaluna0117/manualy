import {
  ApolloClient,
  ApolloLink,
  CombinedGraphQLErrors,
  HttpLink,
  InMemoryCache,
} from '@apollo/client'
import { ErrorLink } from '@apollo/client/link/error'
import {
  USE_SUPABASE_AUTH,
  getIdToken,
  notifySessionExpired,
  onUserChanged,
} from './auth'
import {
  GRAPHQL_ENDPOINT_ERROR_NAME,
  GraphQLEndpointError,
  graphqlEndpointProblem,
  isJsonLikeContentType,
  nonJsonResponseMessage,
} from './graphqlEndpoint'
import { toastError } from './toast'

// GraphQLサーバーの場所。本番(AWS)ではVITE_GRAPHQL_URLで差し替える
const uri = import.meta.env.VITE_GRAPHQL_URL ?? 'http://localhost:3000/graphql'

/**
 * 宛先の設定が噛み合っていないときの説明(噛み合っていればnull)。
 *
 * 認証をsupabaseに変えたのにVITE_GRAPHQL_URLを直し忘れる、という
 * 組み合わせを起動時に見つけるためのもの。ログイン画面にも出す
 * (components/auth/LoginScreen.tsx)。
 * **Cognito方式では常にnull。** AWSは同じオリジンにまとめてあるので、
 * 相対パスが正しい設定になる
 */
export const GRAPHQL_ENDPOINT_PROBLEM = graphqlEndpointProblem({
  uri,
  useSupabaseAuth: USE_SUPABASE_AUTH,
})
if (GRAPHQL_ENDPOINT_PROBLEM) {
  console.error(`[Manualy] ${GRAPHQL_ENDPOINT_PROBLEM}`)
}

/**
 * 応答がJSONかどうかを見てから返すfetch。
 *
 * 宛先が相対パスのままだと、SPAのフォールバックで/graphqlへのPOSTにも
 * index.htmlが HTTP 200 / text/html で返る。そのまま渡すと
 * 「Unexpected token '<'」で終わり、**どこへ送って何が返ったのかが
 * 一言も出ない。** 画面はログインできたうえで中身だけ空になり、
 * 実際に一度これが「データが消えた」と受け取られている。
 * ここで宛先ごと言葉にして、静かに壊れないようにする
 */
async function fetchGraphQL(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init)
  // 300番台以降はApolloに任せる。Apolloは本文を読む前に
  // statusCode付きのServerErrorを投げるので、ここで先回りすると
  // 401(ログイン切れ)の検知が動かなくなる
  if (!response.ok) return response
  const contentType = response.headers.get('content-type')
  if (!isJsonLikeContentType(contentType)) {
    throw new GraphQLEndpointError(
      nonJsonResponseMessage(uri, response.status, contentType),
    )
  }
  return response
}

// 毎リクエストのAuthorizationヘッダにIDトークンを添付する
const authLink = new ApolloLink((operation, forward) => {
  const token = getIdToken()
  if (token) {
    operation.setContext(
      ({ headers = {} }: { headers?: Record<string, string> }) => ({
        headers: { ...headers, authorization: `Bearer ${token}` },
      }),
    )
  }
  return forward(operation)
})

/**
 * 認証を拒否されたら、アプリ本体に伝えてログインし直してもらう。
 *
 * これが無いと、ログインが切れたときに全部のクエリが静かに空を返し、
 * 画面は「マニュアルが1件も無い・フォルダも無い・管理者でもない」ように
 * 見える。データが消えたようにしか見えないので、必ず表に出す。
 */
const authErrorLink = new ErrorLink(({ error, result }) => {
  const byGraphQL =
    CombinedGraphQLErrors.is(error) &&
    error.errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED')
  // ネットワーク層で401が返る場合(GraphQLの本文が無い)にも備える
  const byStatus =
    !!error && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 401
  const byResult = result?.errors?.some(
    (e) => e.extensions?.code === 'UNAUTHENTICATED',
  )
  if (byGraphQL || byStatus || byResult) notifySessionExpired()
})

/** 宛先違いのエラーか(HttpLinkはfetchが投げたエラーをそのまま流す) */
function isEndpointError(error: unknown): error is Error {
  return (
    error instanceof GraphQLEndpointError ||
    (error instanceof Error && error.name === GRAPHQL_ENDPOINT_ERROR_NAME)
  )
}

/**
 * 宛先違いは画面にも出す。
 *
 * 一覧のerrorを表示していない画面(サイドバーの履歴など)もあるので、
 * クエリの戻り値だけに任せると黙って空になる。設定ミスは全部の通信で
 * 同じように起きるため、**1度だけ**出して積み上がらないようにする
 */
let endpointErrorNotified = false
const endpointErrorLink = new ErrorLink(({ error }) => {
  if (!isEndpointError(error) || endpointErrorNotified) return
  endpointErrorNotified = true
  toastError('サーバーに接続できませんでした', error.message)
})

export const apolloClient = new ApolloClient({
  link: ApolloLink.from([
    endpointErrorLink,
    authErrorLink,
    authLink,
    new HttpLink({ uri, fetch: fetchGraphQL }),
  ]),
  cache: new InMemoryCache(),
})

// 共用PCで別の人がサインインしたら、前の人の会話履歴や権限を捨てる。
// これが無いと、後から入った一般ユーザーの画面に前の管理者の会話と
// 管理ボタンが出たままになる。lib/authから直接ここを呼ぶと循環importに
// なるので、購読の形で受け取っている
onUserChanged(() => {
  // 捨てるだけで、取り直しは新しい画面の描画に任せる(clearStoreは
  // resetStoreと違って自動では取り直さない)
  void apolloClient.clearStore()
})
