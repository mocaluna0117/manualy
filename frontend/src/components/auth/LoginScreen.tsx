import { Button, Heading, Input, Text, VStack } from '@chakra-ui/react'
import { useState, type FormEvent } from 'react'
// Cognito版だけが使う。外部のログイン画面へ飛ばすsigninRedirectは
// Cognito固有の考え方なので、方式共通のuseAuthには入れていない
import { useAuth as useOidcAuth } from 'react-oidc-context'
import { USE_SUPABASE_AUTH, authErrorMessage, useAuth } from '../../lib/auth'
import { AUTH_STARTUP_TIMEOUT_MESSAGE } from '../../lib/authState'
import { GRAPHQL_ENDPOINT_PROBLEM } from '../../lib/apollo'
import { supabaseClient } from '../../lib/supabase'

interface LoginScreenProps {
  /**
   * ログインが切れて戻ってきた場合。
   * 何も言わずにログイン画面を出すと「勝手にログアウトされた」ように
   * 見えるので、理由と「データは残っている」ことをはっきり書く
   */
  expired?: boolean
}

/** 上に共通で出す見出しと案内(どちらの方式でも同じ文言・同じ見た目) */
function LoginHeader({ expired }: { expired: boolean }) {
  return (
    <>
      <Heading size="2xl">Manualy</Heading>
      {expired && (
        <VStack gap={1}>
          <Text color="orange.fg" fontWeight="bold">
            ログインの有効期限が切れました
          </Text>
          <Text color="fg.muted" fontSize="sm" textAlign="center">
            もう一度サインインしてください。
            マニュアルやフォルダはそのまま残っています。
          </Text>
        </VStack>
      )}
      {/* 全角30文字あり、狭い画面では文の途中で折り返して読みにくい。
          スマホでは短い文にする(何をすればよいかは下のボタンで分かる)。
          表示の出し分けはCSSで行うので、開いた瞬間に文が入れ替わらない */}
      {!expired && (
        <>
          <Text color="fg.muted" whiteSpace="nowrap" hideBelow="md">
            このサイトは社内向けです。アカウントでサインインしてください
          </Text>
          <Text color="fg.muted" fontSize="sm" whiteSpace="nowrap" hideFrom="md">
            社内向けのサイトです
          </Text>
        </>
      )}
      {/* 宛先の設定が噛み合っていないビルド。放っておくと「ログインは
          できるのに中身が全部空」になり、データが消えたように見える。
          サインインする前に、まずここで気づけるようにする */}
      {GRAPHQL_ENDPOINT_PROBLEM && (
        <Text
          fontSize="sm"
          color="fg.error"
          textAlign="center"
          maxW="480px"
          px={2}
        >
          設定を確認してください: {GRAPHQL_ENDPOINT_PROBLEM}
        </Text>
      )}
    </>
  )
}

/** Cognito版。ボタンを押すとHosted UI(外部のログイン画面)へ飛ぶ */
function CognitoLoginScreen({ expired = false }: LoginScreenProps) {
  const auth = useOidcAuth()

  return (
    <VStack h="100dvh" justify="center" gap={6} px={4}>
      <LoginHeader expired={expired} />
      <Button
        size="lg"
        colorPalette="blue"
        onClick={() => void auth.signinRedirect()}
      >
        {expired ? 'サインインし直す' : 'サインイン'}
      </Button>
      {auth.error && (
        <Text fontSize="sm" color="fg.error">
          サインインでエラーが発生しました: {auth.error.message}
        </Text>
      )}
    </VStack>
  )
}

/**
 * Supabase版。Hosted UIが無いのでアプリ内のフォームで受ける。
 *
 * 新規登録は出さない。Supabase側でdisable_signup=trueにしてあり、
 * 出しても必ず失敗する(利用者の追加は管理者が行う)
 */
function SupabaseLoginScreen({ expired = false }: LoginScreenProps) {
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setMessage(null)
    try {
      const { error } = await supabaseClient().auth.signInWithPassword({
        // 前後の空白は貼り付け事故として黙って落とす。
        // パスワードのほうは空白も文字なので触らない
        email: email.trim(),
        password,
      })
      // 成功したときの画面の切り替えはAuthProviderが受け持つ
      // (onAuthStateChangeのSIGNED_INで復帰を通知する)
      if (error) setMessage(authErrorMessage(error))
    } catch (err) {
      setMessage(authErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <VStack h="100dvh" justify="center" gap={6} px={4}>
      <LoginHeader expired={expired} />
      {/* 素のformで包む。これでEnterでも送信でき、ブラウザの
          パスワード保存も効く(30人が毎回手で打つ運用にしないため) */}
      <form onSubmit={(e) => void handleSubmit(e)} style={{ width: '100%' }}>
        <VStack gap={3} align="stretch" w="100%" maxW="320px" mx="auto">
          <Input
            type="email"
            name="email"
            autoComplete="username"
            placeholder="メールアドレス"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            placeholder="パスワード"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Button
            type="submit"
            size="lg"
            colorPalette="blue"
            loading={submitting}
          >
            {expired ? 'サインインし直す' : 'サインイン'}
          </Button>
        </VStack>
      </form>
      {message && (
        <Text fontSize="sm" color="fg.error" textAlign="center">
          {message}
        </Text>
      )}
      {/* 設定ミスのビルド(接続先が無い)もここに出す。白い画面で
          黙って止まると、何が起きたのか誰にも分からない */}
      {auth.error && (
        <Text fontSize="sm" color="fg.error" textAlign="center">
          {auth.error.message}
        </Text>
      )}
      {/* Supabaseの返事を待ちきれずにここへ来た場合。理由を出さないと
          「勝手にログアウトされた」「固まった」としか受け取れない */}
      {auth.startupTimedOut && (
        <Text fontSize="sm" color="orange.fg" textAlign="center" maxW="360px">
          {AUTH_STARTUP_TIMEOUT_MESSAGE}
        </Text>
      )}
      {/* パスワード再設定メールが使えるか未確認なので、リンクは置かない。
          再発行は管理者の手作業という前提にしておく */}
      <Text fontSize="xs" color="fg.muted" textAlign="center">
        パスワードが分からないときは管理者に連絡してください
      </Text>
    </VStack>
  )
}

/**
 * 未ログイン時に表示する画面。
 * ここ自身はフックを持たないので、方式で中身を出し分けてよい
 */
export function LoginScreen(props: LoginScreenProps) {
  return USE_SUPABASE_AUTH ? (
    <SupabaseLoginScreen {...props} />
  ) : (
    <CognitoLoginScreen {...props} />
  )
}
