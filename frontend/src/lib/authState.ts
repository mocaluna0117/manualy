/**
 * ログイン状態の復元まわりの判断だけを集めたところ。
 *
 * AuthProviderはSupabaseの購読やタイマーと絡んでいて、ブラウザを
 * 立ち上げないと確かめられない。判断そのものはここに出しておくと、
 * `node --test`だけで固定できる(src/lib/authState.test.ts)。
 * ここには**副作用も外部importも置かない**。
 */

/**
 * 復元がどこまで進んだか。
 *
 * - loading: まだ何も分からない(アプリ本体を出すとトークン未取得のまま通信してしまう)
 * - ready:   Supabaseから返事が来た(セッションの有無はどちらでもよい)
 * - timeout: 返事が来ないまま時間切れ。ログイン画面と理由を出す
 */
export type AuthPhase = 'loading' | 'ready' | 'timeout'

/** 復元中に起きること。sessionはonAuthStateChangeが1回呼ばれたこと */
export type AuthPhaseEvent = 'session' | 'timeout'

/**
 * 復元の返事をどれだけ待つか。
 *
 * auth-jsは 200ms→12.8s のバックオフで7回再試行するので、Supabaseが
 * 応答しないと**25秒**ほど何も返って来ない。その間ずっと無地のスピナー
 * だと、利用者には固まったようにしか見えない。長すぎず、遅い回線で
 * 誤って切らない程度の6秒にする
 */
export const AUTH_BOOTSTRAP_TIMEOUT_MS = 6000

/** 時間切れのときにログイン画面へ出す文言 */
export const AUTH_STARTUP_TIMEOUT_MESSAGE =
  'サインインの確認に時間がかかっています。通信を確認してもう一度開いてください'

/**
 * 次の復元段階を決める。
 *
 * **時間切れのあとに返事が来たら復帰させる。** 購読は解除しないので、
 * 遅れてINITIAL_SESSIONが届くことがある。そのときログイン画面に
 * 固定したままだと、入れるのに入れない状態になる。
 * 逆に、返事が来たあとで時間切れのタイマーが発火しても戻さない
 */
export function nextAuthPhase(
  current: AuthPhase,
  event: AuthPhaseEvent,
): AuthPhase {
  if (event === 'session') return 'ready'
  return current === 'loading' ? 'timeout' : current
}

/**
 * 直前にこのタブを使っていた人と、今サインインした人が別人か。
 *
 * 別人なら前の人のキャッシュ(会話履歴・権限)を捨てる必要がある。
 * **どちらかが不明なら「別人」とは言わない。** 初回の復元
 * (前の人が居ない)で捨てても意味が無く、サインアウトだけの通知
 * (次の人が居ない)で捨てると、まだ画面に居る本人の表示が消える
 */
export function isDifferentUser(
  previousUserId: string | null,
  nextUserId: string | null,
): boolean {
  if (!previousUserId || !nextUserId) return false
  return previousUserId !== nextUserId
}
