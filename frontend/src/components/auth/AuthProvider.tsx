import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  AuthProvider as OidcAuthProvider,
  useAuth as useOidcAuth,
} from 'react-oidc-context'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import {
  AuthContext,
  USE_SUPABASE_AUTH,
  currentSupabaseSession,
  isSupabaseSessionExpired,
  notifySessionRestored,
  notifyUserChanged,
  oidcConfig,
  rememberSession,
  type Auth,
  type AuthUser,
} from '../../lib/auth'
import {
  AUTH_BOOTSTRAP_TIMEOUT_MS,
  isDifferentUser,
  nextAuthPhase,
} from '../../lib/authState'
import type { SignOutResult } from '../../lib/logout'
import { supabaseClient } from '../../lib/supabase'

/** Supabaseのセッションを、画面が使う形(react-oidc-contextのUser相当)に直す */
function toAuthUser(session: Session): AuthUser {
  return {
    expired: isSupabaseSessionExpired(session),
    profile: { email: session.user.email },
  }
}

/** Supabase Auth版。ログイン状態をonAuthStateChangeから受け取って配る */
function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  // クライアントの生成は最初の描画で1度だけ試す。接続先が設定されていない
  // ビルドかどうかは最初から決まっているので、effectの中でsetStateして
  // 連鎖描画を起こす必要がない(lintにも止められる)。
  // 失敗しても投げずに抱えておき、ログイン画面に理由を出す。
  // 白い画面で黙って止まると、何が起きたのか誰にも分からない
  const [created] = useState<{ client: SupabaseClient | null; error?: Error }>(
    () => {
      try {
        return { client: supabaseClient() }
      } catch (e) {
        return {
          client: null,
          error: e instanceof Error ? e : new Error(String(e)),
        }
      }
    },
  )
  // 復元を待つ相手が居ないなら、最初から待たない
  const [phase, dispatchPhase] = useReducer(
    nextAuthPhase,
    created.client ? 'loading' : 'ready',
  )
  const [session, setSession] = useState<Session | null>(null)
  // 直前にこのタブでサインインしていた人。**サインアウトでも消さない。**
  // 消してしまうと「aがログアウト→bがログイン」でaのキャッシュを
  // 捨てそこねる(ログアウトの後始末が失敗していた場合に残る)
  const lastUserId = useRef<string | null>(null)

  useEffect(() => {
    const client = created.client
    if (!client) return
    const { data } = client.auth.onAuthStateChange((event, next) => {
      // setStateより先に写す。再描画で走るクエリがトークンを取り損ねないため
      rememberSession(next)
      // 別の人が入ったなら、前の人のキャッシュを捨てるよう先に伝える。
      // 再描画より前に始めたいので、setSessionより先に呼ぶ
      const nextUserId = next?.user.id ?? null
      if (isDifferentUser(lastUserId.current, nextUserId)) notifyUserChanged()
      if (nextUserId) lastUserId.current = nextUserId
      setSession(next)
      // 購読した直後にINITIAL_SESSIONが1回来る。それを待って
      // はじめてアプリ本体を出す(getSessionを別に呼ぶ必要はない)
      dispatchPhase('session')
      if (
        next &&
        !isSupabaseSessionExpired(next) &&
        (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')
      ) {
        notifySessionRestored()
      }
    })
    // 「購読すればINITIAL_SESSIONが必ず1回来る」はSupabaseが応答して
    // はじめて成り立つ。届かないとauth-jsが 200ms→12.8s のバックオフで
    // 7回再試行し、**25秒ほど無地のスピナーのまま**になる。
    // 時間を切ってログイン画面と理由を出す。**購読は解除しない**ので、
    // 遅れてINITIAL_SESSIONが届けばそのまま復帰する
    const timer = window.setTimeout(
      () => dispatchPhase('timeout'),
      AUTH_BOOTSTRAP_TIMEOUT_MS,
    )
    return () => {
      window.clearTimeout(timer)
      data.subscription.unsubscribe()
    }
  }, [created])

  const signinSilent = useCallback(async (): Promise<AuthUser | null> => {
    const client = created.client
    if (!client) return null
    const current = currentSupabaseSession()
    // まだ期限内のトークンで拒否されたのなら、更新しても中身が同じ
    // トークンが出るだけで結果は変わらない。ここで「戻れた」と返すと
    // App側がすぐ画面を出し直し、401→更新→401の往復が止まらなくなる
    // (切り替え途中、サーバーがまだSupabaseのトークンを検証できない間に
    //  必ず起きる)。素直に諦めてログイン画面を出す
    if (current && !isSupabaseSessionExpired(current)) return null
    try {
      const { data, error: refreshError } = await client.auth.refreshSession()
      if (refreshError || !data.session) return null
      rememberSession(data.session)
      return toAuthUser(data.session)
    } catch {
      // 通信できないときも騒がない。ログイン画面を出すだけ
      return null
    }
  }, [created])

  const removeUser = useCallback(async (): Promise<SignOutResult> => {
    const client = created.client
    if (!client) return {}
    // 既定のscopeは'global'で、他の端末のログインまで切れてしまう。
    // Cognito版は押したブラウザだけが切れていたので、そこに合わせる
    const { error } = await client.auth.signOut({ scope: 'local' })
    // **失敗を握りつぶさない。** 切れていないのに切れたように見えると、
    // 共用PCで次の人がそのまま使えてしまう。判断は呼び元に任せる
    return { error }
  }, [created])

  const value = useMemo<Auth>(
    () => ({
      isLoading: phase === 'loading',
      // 期限切れでもtrueにする。react-oidc-contextと同じ意味にしておくと、
      // App側の「未ログイン」と「期限切れ」の出し分けがそのまま動く
      isAuthenticated: session !== null,
      user: session ? toAuthUser(session) : null,
      error: created.error,
      startupTimedOut: phase === 'timeout',
      signinSilent,
      removeUser,
    }),
    [phase, session, created, signinSilent, removeUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/**
 * react-oidc-contextの値をそのままAuthContextへ流すだけの橋渡し。
 *
 * 方式でuseAuthの実体を切り替えるとフックの条件呼び出しになる。
 * Provider側で吸収しておけば、画面側のuseAuthは常にuseContext1つで済む
 */
function CognitoAuthBridge({ children }: { children: ReactNode }) {
  const auth = useOidcAuth()
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
}

/**
 * アプリ全体にログイン状態を配るProvider。
 * どちらの認証方式を使うかはここだけが知っていて、
 * 画面側は lib/auth の useAuth を呼ぶだけでよい
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (USE_SUPABASE_AUTH) {
    return <SupabaseAuthProvider>{children}</SupabaseAuthProvider>
  }
  return (
    <OidcAuthProvider {...oidcConfig}>
      <CognitoAuthBridge>{children}</CognitoAuthBridge>
    </OidcAuthProvider>
  )
}
