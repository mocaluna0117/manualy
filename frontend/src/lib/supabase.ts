import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let client: SupabaseClient | null = null

/**
 * Supabaseのクライアント。**最初に必要になったときだけ作る。**
 *
 * モジュールを読んだ瞬間に作ってしまうと、Cognito方式でビルドしたとき
 * (VITE_SUPABASE_*が空のとき)にも接続先の無いクライアントができてしまう。
 * 切り替え日までの間はAWS版が本番なので、Supabaseの設定が無くても
 * 画面が立ち上がることを優先する。
 *
 * ここに置く鍵は publishable(anon)だけ。VITE_で始まる値は全部
 * 公開されるJSに埋め込まれるので、service_roleは絶対に置かない。
 */
export function supabaseClient(): SupabaseClient {
  if (client) return client
  if (!url || !anonKey) {
    throw new Error(
      'VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY が設定されていません。Supabase認証でビルドするときは両方必要です',
    )
  }
  client = createClient(url, anonKey, {
    auth: {
      // タブを閉じても入り直さずに済むようにセッションを保存する
      // (既定のlocalStorage。sessionStorageにすると閉じるたびに
      //  メールとパスワードの手入力になり、現場では確実に嫌われる)
      persistSession: true,
      // アクセストークンは1時間で切れる。裏で更新させる
      autoRefreshToken: true,
      // URLのハッシュからセッションを拾う機能。メールリンクでのログインは
      // 使わないので切る。付けたままだと関係のない#付きURLを勝手に
      // 書き換えられ、原因の分かりにくい不具合の元になる
      detectSessionInUrl: false,
    },
  })
  return client
}
