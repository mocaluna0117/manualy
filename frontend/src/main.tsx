import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { ChakraProvider, defaultSystem } from '@chakra-ui/react'
import { Toaster } from './components/ui/toaster'
import { AuthProvider } from './components/auth/AuthProvider.tsx'
import App from './App.tsx'
import { apolloClient } from './lib/apollo.ts'
import { watchSystemTheme } from './lib/settings.ts'

// 「端末準拠」を選んでいる間、OS側の配色変更に追随する
// (初期適用はindex.htmlのスクリプトが担当)
watchSystemTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <ApolloProvider client={apolloClient}>
        <ChakraProvider value={defaultSystem}>
          <App />
          {/* 画面右下の通知。アプリに1つだけ置く */}
          <Toaster />
        </ChakraProvider>
      </ApolloProvider>
    </AuthProvider>
  </StrictMode>,
)
