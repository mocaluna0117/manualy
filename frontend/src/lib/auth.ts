import { createContext, useContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { SignOutResult } from './logout'

/**
 * どちらの認証方式でビルドするか。'cognito'(既定)か'supabase'。
 *
 * **未設定なら必ずCognito**にする。「Supabaseの値が入っていればSupabase」
 * のような自動判定にすると、.env.productionにSupabaseの値を書き足した
 * 瞬間にAWS版のビルドまで切り替わってしまう(.env.productionはAWSの
 * Dockerfileにも読み込まれる)。切り替え日まではAWSが本番なので、
 * 明示的に指定したときだけ新しい方式に倒す。
 */
const authProvider =
  (import.meta.env.VITE_AUTH_PROVIDER as string | undefined) ?? 'cognito'

/** Supabase Authでビルドしているか(画面側の分岐はすべてこれを見る) */
export const USE_SUPABASE_AUTH = authProvider === 'supabase'

const authority = import.meta.env.VITE_COGNITO_AUTHORITY as string
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN as string

// react-oidc-context(AuthProvider)に渡す設定。
// authority(発行者URL)からOIDCの各エンドポイントを自動発見してくれる
export const oidcConfig = {
  authority,
  client_id: clientId,
  redirect_uri: window.location.origin, // ログイン後に戻ってくる場所
  response_type: 'code', // 認可コードフロー(+PKCE)。SPAの標準
  scope: 'openid email profile',
  // Cognitoのログイン画面を日本語で出す。
  // 既定は英語で、langを付けたときだけ日本語になる(付けた後はCognitoが
  // 言語をcookieに覚えるので、次回以降は付けなくても日本語のまま)
  extraQueryParams: { lang: 'ja' },
  // ログインから戻った直後、URLに残る ?code=...&state=... を消して見た目を綺麗に
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, window.location.pathname)
  },
}

/** sessionStorageに入っているoidc-client-tsのユーザー情報 */
interface StoredUser {
  id_token?: string
  /** トークンが切れる時刻(UNIX秒)。oidc-client-tsが書く */
  expires_at?: number
}

function storedUser(): StoredUser | null {
  const raw = sessionStorage.getItem(`oidc.user:${authority}:${clientId}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredUser
  } catch {
    return null
  }
}

// --- Supabase方式のセッションを、Reactの外から同期で読めるようにする ---
//
// getIdToken/isSessionExpiredはApolloのリンクやfetchの直前から
// 「同期で」呼ばれる。supabase-jsのgetSession()はPromiseなので使えない。
// かといってlocalStorageを直接読むと、supabase-jsの保存形式
// (キー名と値の形)に頼ることになり、ライブラリを上げた日に静かに壊れる。
// そこでAuthProviderが受け取った最新のセッションをここへ写し、
// 同期の読み取りはこの写しだけを見る。

let supabaseSession: Session | null = null

/** AuthProviderから呼ぶ。Reactの外から読めるように今のセッションを写す */
export function rememberSession(session: Session | null) {
  supabaseSession = session
}

/** 写してあるセッション(Providerの外から今の状態を知りたいとき) */
export function currentSupabaseSession(): Session | null {
  return supabaseSession
}

/** Supabaseのセッションが期限切れか(expires_atはUNIX秒) */
export function isSupabaseSessionExpired(session: Session): boolean {
  if (typeof session.expires_at !== 'number') return false
  return session.expires_at * 1000 <= Date.now()
}

/**
 * ログイン中ユーザーのIDトークンを取り出す。
 *
 * Cognito: oidc-client-tsはユーザー情報をsessionStorageに保存するので、
 * Reactの外(Apolloのリンク)からでも読めるようにここで直接参照する。
 * Supabase: IDトークンという概念が無く、APIに出すのはアクセストークン。
 * 呼び出し側(apollo.ts / chatStream.ts)を変えずに済むよう名前は変えない。
 *
 * **切れたトークンは返さない。** 返してしまうとサーバーに全部401で弾かれ、
 * 画面は「マニュアルが1件も無い・管理者でもない」ように見える。
 * 実際にそう見えて「データが消えた」と受け取られたことがある。
 */
export function getIdToken(): string | null {
  if (USE_SUPABASE_AUTH) {
    const token = supabaseSession?.access_token
    if (!token) return null
    return isSessionExpired() ? null : token
  }
  const user = storedUser()
  if (!user?.id_token) return null
  return isSessionExpired() ? null : user.id_token
}

/**
 * ログインの有効期限が切れているか。
 *
 * どちらの方式でも裏で自動更新するが、端末がスリープしていた・
 * 更新用トークンが切れた等で失敗することがある。そのとき
 * ユーザー情報は手元に残ったままなので、期限を自分で見る。
 *
 * **未ログインのときはfalse。** 期限切れ(=入り直せば戻れる)と
 * そもそも入っていない状態は、画面の出し分けが変わるので区別する。
 */
export function isSessionExpired(): boolean {
  if (USE_SUPABASE_AUTH) {
    if (!supabaseSession) return false // そもそも未ログイン
    return isSupabaseSessionExpired(supabaseSession)
  }
  const user = storedUser()
  if (!user) return false // そもそも未ログイン。期限切れとは区別する
  if (typeof user.expires_at !== 'number') return false
  return user.expires_at * 1000 <= Date.now()
}

// --- ログインが切れたことをアプリ本体へ伝える ---
// Apolloのリンクから通知したいが、そこはReactの外なので購読の形にする

type Listener = () => void
const listeners = new Set<Listener>()

/** ログインが切れたときに呼ばれる。戻り値を呼ぶと購読をやめる */
export function onSessionExpired(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** サーバーに認証を拒否されたことを知らせる */
export function notifySessionExpired() {
  for (const listener of listeners) listener()
}

// --- 逆に、ログインし直せたことをアプリ本体へ伝える ---
//
// Cognitoは外部のログイン画面へ飛んで戻ってくるので、成功すると
// ページごと作り直され、「期限切れ」の印は自然に消えていた。
// Supabaseはアプリ内のフォームで入り直すためAppが生き残り、
// 印を立てたままログイン画面に固定されてしまう(入れるのに入れない)。
// そこで復帰も同じ購読の形で伝える。

const restoredListeners = new Set<Listener>()

/** ログインし直せたときに呼ばれる。戻り値を呼ぶと購読をやめる */
export function onSessionRestored(listener: Listener): () => void {
  restoredListeners.add(listener)
  return () => restoredListeners.delete(listener)
}

/** 有効なセッションが手に入ったことを知らせる */
export function notifySessionRestored() {
  for (const listener of restoredListeners) listener()
}

// --- このタブを使う人が入れ替わったことを伝える ---
//
// Cognitoは外部の画面へ飛んで戻るので、別の人が入るとページごと
// 作り直され、前の人の一覧や権限は自然に消えていた。Supabaseは
// アプリ内で入れ替わるため、**前の人のキャッシュがそのまま残る。**
// 共用PCでは、後から入った一般ユーザーの画面に前の管理者の会話履歴と
// 管理ボタンが出てしまう。
//
// 捨てるのはApolloのキャッシュだが、lib/authがlib/apolloをimportすると
// 循環する(apollo→authでトークンを読んでいる)。期限切れの通知と
// 同じ購読の形にして、lib/apollo側から受け取る

const userChangedListeners = new Set<Listener>()

/** 別の人がサインインしたときに呼ばれる。戻り値を呼ぶと購読をやめる */
export function onUserChanged(listener: Listener): () => void {
  userChangedListeners.add(listener)
  return () => userChangedListeners.delete(listener)
}

/** 直前の人と別の人がサインインしたことを知らせる */
export function notifyUserChanged() {
  for (const listener of userChangedListeners) listener()
}

/** Cognito側のセッションも含めて完全にログアウトする */
export function signOutRedirect() {
  const logoutUri = encodeURIComponent(window.location.origin)
  // ログアウト後にログイン画面が出る場合もあるので、こちらにも言語を渡す
  window.location.href = `${cognitoDomain}/logout?client_id=${clientId}&logout_uri=${logoutUri}&lang=ja`
}

// --- 画面が使うログイン情報(方式によらず同じ形) ---

/**
 * 画面が使うログイン中のユーザー。
 * react-oidc-contextのUserと、Supabaseのセッションの「共通部分」だけを持つ。
 * こう決めておくと、App.tsxやSidebar.tsxは方式を知らずに済む
 */
export interface AuthUser {
  /** トークンの期限が切れているか */
  expired?: boolean
  profile: { email?: string }
}

export interface Auth {
  /** 復元中(ここでアプリ本体を出すとトークン未取得のまま通信してしまう) */
  isLoading: boolean
  /** 期限切れでもセッションが手元にあればtrue(react-oidc-contextと同じ意味) */
  isAuthenticated: boolean
  // react-oidc-contextのAuthContextProps側が省略可なので、こちらも省略可にする。
  // 揃えておかないとCognito版の値をそのまま流し込めない
  user?: AuthUser | null
  error?: Error
  /**
   * 復元の返事が時間内に来なかった(Supabaseに届いていない)。
   * Cognito版には無い状態なので省略可にしてある
   */
  startupTimedOut?: boolean
  /** 黙って更新を試す。だめでも投げずにnullを返す */
  signinSilent: () => Promise<AuthUser | null>
  /**
   * このブラウザのログインを破棄する。
   *
   * **結果を返す。** 失敗を握りつぶすと、切れていないのに切れたように
   * 見えてしまう(共用PCで次の人がそのまま使える)。
   * react-oidc-contextのremoveUserは何も返さないので、voidも許す
   */
  removeUser: () => Promise<SignOutResult | void>
}

export const AuthContext = createContext<Auth | null>(null)

export function useAuth(): Auth {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuthはAuthProviderの内側で使うこと')
  }
  return ctx
}

/**
 * Supabase Authのエラーを日本語にする。
 *
 * supabase-jsのエラークラスをimportして判定すると、Cognito方式の
 * ビルドにもsupabase-jsが実行時に読み込まれてしまう。ここは
 * codeとstatusを見るだけで足りるので、形だけで判定する。
 *
 * ログインの失敗は**原因を言い分けない**。パスワード違いも未登録も
 * サーバーが同じ invalid_credentials を返すし、言い分けると
 * 「このメールは登録されている」を外から確かめられてしまう
 */
export function authErrorMessage(error: unknown): string {
  const e = error as { code?: string; status?: number; message?: string } | null
  const code = e?.code
  if (code === 'invalid_credentials') {
    return 'メールアドレスかパスワードが違います'
  }
  if (code === 'weak_password') {
    return 'パスワードは10文字以上にしてください'
  }
  if (code === 'same_password') {
    return '今までと違うパスワードを入れてください'
  }
  if (code === 'signup_disabled' || code === 'user_not_found') {
    return 'このメールアドレスは登録されていません。管理者に連絡してください'
  }
  if (code === 'email_not_confirmed') {
    return 'メールアドレスの確認が済んでいません。管理者に連絡してください'
  }
  if (
    code === 'over_request_rate_limit' ||
    code === 'over_email_send_rate_limit' ||
    e?.status === 429
  ) {
    return '試行回数が多すぎます。少し待ってからやり直してください'
  }
  if (
    code === 'session_not_found' ||
    code === 'refresh_token_not_found' ||
    code === 'session_expired'
  ) {
    return 'ログインの情報が無効になりました。もう一度サインインしてください'
  }
  // 通信できないときはSupabaseのエラーですらないことがある(codeが無い)
  if (!code && e?.message) {
    return `うまくいきませんでした: ${e.message}`
  }
  return 'うまくいきませんでした。時間をおいてやり直してください'
}
