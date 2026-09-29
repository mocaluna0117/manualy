import { Spinner, VStack } from '@chakra-ui/react'
import { useEffect, useRef, useState } from 'react'
import { LoginScreen } from './components/auth/LoginScreen'
import { ChatHome } from './components/chat/ChatHome'
import { AppLayout } from './components/layout/AppLayout'
import {
  ManualExplorer,
  type ExplorerFolder,
} from './components/manual/ManualExplorer'
import { ManualSearchResults } from './components/manual/ManualSearchResults'
import { TrashView } from './components/manual/TrashView'
import { ManualViewerProvider } from './components/manual/ManualViewerProvider'
import type { Category } from './graphql/categories'
import {
  isSessionExpired,
  onSessionExpired,
  onSessionRestored,
  useAuth,
} from './lib/auth'

// メインエリアに何を表示するか。判別可能ユニオン型で「今どの画面か」を1つの値で表す
type View =
  | { type: 'home' } // 新規チャット
  | { type: 'chat'; conversationId: string } // 既存の会話
  | { type: 'manuals' } // エクスプローラーのルート(全フォルダ)
  | { type: 'category'; category: Category }
  | { type: 'uncategorized' } // カテゴリ未設定のマニュアル一覧
  | { type: 'trash' } // ゴミ箱
  | { type: 'search'; keyword: string }

const VIEW_STORAGE_KEY = 'manualSearch.view'

/** 前回開いていた画面をlocalStorageから復元する(壊れていたらホーム) */
function loadInitialView(): View {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as View
      if (saved && typeof saved === 'object' && 'type' in saved) return saved
    }
  } catch {
    // 壊れたデータは無視してホームへ
  }
  return { type: 'home' }
}

function App() {
  const auth = useAuth()
  const [view, setView] = useState<View>(loadInitialView)
  // サーバーに認証を拒否されたら、その場でログイン画面へ戻す。
  // 黙って空の画面を出すと「データが消えた」ようにしか見えない
  const [expired, setExpired] = useState(isSessionExpired)
  useEffect(() => onSessionExpired(() => setExpired(true)), [])
  // アプリ内のフォームで入り直したときは、この印を自分で畳む必要がある。
  // Cognitoは外部の画面へ飛んで戻る=Appごと作り直されていたので不要だったが、
  // Supabaseは同じAppが生き残るため、印が残ったままログイン画面に固定される
  useEffect(() => onSessionRestored(() => setExpired(false)), [])

  // 期限切れに気づいたら、まず黙って更新を試す。
  // 更新用トークンは30日有効なので、たいていはこれで戻り、利用者は
  // 何も気づかない。1度きりにする(失敗し続けて叩き続けないため)
  const renewTried = useRef(false)
  const stale = expired || auth.user?.expired === true
  useEffect(() => {
    // 戻れたら次に切れたときも試せるようにしておく
    if (!stale) {
      renewTried.current = false
      return
    }
    if (renewTried.current) return
    renewTried.current = true
    void auth
      .signinSilent()
      .then((user) => {
        if (user && !user.expired) setExpired(false)
      })
      .catch(() => {
        // 戻せなければログイン画面を出すだけ。ここで騒がない
      })
  }, [stale, auth])

  // 画面を切り替えるたびに保存(リロードしても同じ画面に戻れる)
  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view))
  }, [view])

  const isChat = view.type === 'home' || view.type === 'chat'

  // 認証状態の確認中(リダイレクトから戻った直後など)
  if (auth.isLoading) {
    return (
      <VStack h="100dvh" justify="center">
        <Spinner size="lg" />
      </VStack>
    )
  }

  // 未ログインならログイン画面だけを見せる(アプリ本体は一切見せない)。
  // 期限切れもここで止める。react-oidc-contextはトークンが切れていても
  // ユーザー情報が残っていればisAuthenticatedをtrueにするため、
  // これが無いと「空っぽの画面」がそのまま表示されてしまう
  if (!auth.isAuthenticated || stale) {
    return <LoginScreen expired={auth.isAuthenticated} />
  }

  return (
    <ManualViewerProvider>
      <AppLayout
      selectedCategoryId={view.type === 'category' ? view.category.id : null}
      selectedConversationId={view.type === 'chat' ? view.conversationId : null}
      onSelectCategory={(category) =>
        setView(category ? { type: 'category', category } : { type: 'home' })
      }
      onSelectConversation={(conversationId) =>
        setView({ type: 'chat', conversationId })
      }
      onSelectUncategorized={() => setView({ type: 'uncategorized' })}
      onSelectTrash={() => setView({ type: 'trash' })}
      onSelectManualsRoot={() => setView({ type: 'manuals' })}
      onSearch={(keyword) => setView({ type: 'search', keyword })}
    >
      {(view.type === 'manuals' ||
        view.type === 'category' ||
        view.type === 'uncategorized') && (
        <ManualExplorer
          folder={
            view.type === 'category'
              ? view.category
              : view.type === 'uncategorized'
                ? 'uncategorized'
                : null
          }
          onNavigate={(folder: ExplorerFolder) =>
            setView(
              folder === null
                ? { type: 'manuals' }
                : folder === 'uncategorized'
                  ? { type: 'uncategorized' }
                  : { type: 'category', category: folder },
            )
          }
        />
      )}
      {view.type === 'trash' && <TrashView />}
      {view.type === 'search' && (
        <ManualSearchResults key={view.keyword} keyword={view.keyword} />
      )}
      {isChat && (
        <ChatHome
          // keyで会話ごとにコンポーネントを作り直す(前の会話の表示が残らないように)
          key={view.type === 'chat' ? view.conversationId : 'new'}
          conversationId={view.type === 'chat' ? view.conversationId : null}
          onConversationCreated={(conversationId) =>
            setView({ type: 'chat', conversationId })
          }
          // 復元した会話が削除済み/他ユーザーのものだった場合はホームへ
          onConversationNotFound={() => setView({ type: 'home' })}
        />
      )}
    </AppLayout>
    </ManualViewerProvider>
  )
}

export default App
