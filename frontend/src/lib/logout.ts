/**
 * ログアウトの待ち方だけを集めたところ。
 *
 * ここには**副作用も外部importも置かない**(`node --test`で固定するため)。
 */

/** ログアウトの結果。errorが入っていたらセッションは切れていない */
export interface SignOutResult {
  error?: Error | null
}

/** ログアウトの返事をどれだけ待つか */
export const LOGOUT_TIMEOUT_MS = 5000

/** 時間切れのときに画面へ出す理由 */
export const LOGOUT_TIMEOUT_REASON =
  'サーバーから応答がありません。通信を確認して、もう一度お試しください'

export interface LogoutOutcome {
  /** セッションを確かに破棄できたか */
  ok: boolean
  /** 失敗・時間切れの理由(画面に出す) */
  reason?: string
}

/**
 * ログアウトを時間を区切って待つ。
 *
 * Supabaseのlogoutは応答しないことがあり、待ち続けると画面は
 * アプリ本体のまま、エラーも出ない。利用者は「ログアウトした」と
 * 思って席を立つのに、次の人がそのまま使える。共用PCで実害が出るので、
 * **黙って待たない**。時間切れも失敗として返し、呼び元が知らせる
 */
export async function signOutWithTimeout(
  signOut: () => Promise<SignOutResult | void>,
  timeoutMs: number = LOGOUT_TIMEOUT_MS,
): Promise<LogoutOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const onTimeout = new Promise<LogoutOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: LOGOUT_TIMEOUT_REASON }),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([
      Promise.resolve(signOut()).then((result) => ({
        ok: !result?.error,
        reason: result?.error?.message,
      })),
      onTimeout,
    ])
  } catch (e) {
    // 投げられた場合も「切れていない」として扱う。握りつぶさない
    return { ok: false, reason: e instanceof Error ? e.message : undefined }
  } finally {
    // 時間切れの側が残るとタブが閉じるまでタイマーが生き続ける
    clearTimeout(timer)
  }
}

/**
 * ログアウトの後始末をどうするか。
 *
 * - signed-out: サーバーまで通って切れた
 * - local-only: サーバーには届かなかったが、この端末のログインは消えた
 * - failed:     切れていない
 */
export type LogoutDisposition = 'signed-out' | 'local-only' | 'failed'

/** local-only のときに画面へ出す見出し(失敗ではないのでtoastInfoで出す) */
export const LOGOUT_LOCAL_ONLY_TITLE = 'この端末からログアウトしました'

/** local-only のときの補足 */
export const LOGOUT_LOCAL_ONLY_REASON =
  'サーバーには届きませんでしたが、この端末のログイン情報は消えています'

/**
 * 「errorが返った=切れていない」とは限らないので、手元の状態で判断し直す。
 *
 * supabase-jsのlogoutは通信に失敗しても、**手元のセッションを消してから**
 * errorを返す(auth-jsの_signOut。404/401/403とセッション欠落以外は
 * removeCurrentSessionを通ってからerrorを返す)。これをそのまま失敗として
 * 扱うと、実際には切れているのに「ログアウトできませんでした」と出たうえ、
 * 失敗扱いでApolloのキャッシュを捨てそこね、ログイン画面の裏に前の人の
 * 権限と会話一覧が残る。**共用PCではこれが一番まずい。**
 *
 * 時間切れ(応答が返ってこない)のときは手元のセッションも残るので、
 * ここは今まで通り failed になる
 */
export function logoutDisposition(
  outcome: LogoutOutcome,
  localSessionCleared: boolean,
): LogoutDisposition {
  if (outcome.ok) return 'signed-out'
  return localSessionCleared ? 'local-only' : 'failed'
}

/** 後始末(Apolloのキャッシュ破棄)をしてよいか */
export function shouldClearCache(disposition: LogoutDisposition): boolean {
  return disposition !== 'failed'
}
