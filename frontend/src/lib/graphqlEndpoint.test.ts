import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRAPHQL_ENDPOINT_ERROR_NAME,
  GraphQLEndpointError,
  graphqlEndpointProblem,
  isJsonLikeContentType,
  nonJsonResponseMessage,
} from './graphqlEndpoint.ts'

// --- 大13: 「認証はsupabase / GraphQLは相対パス」を黙って通さない ---

test('Supabase認証 + 相対パスは設定漏れとして知らせる', () => {
  const problem = graphqlEndpointProblem({
    uri: '/graphql',
    useSupabaseAuth: true,
  })
  assert.ok(problem)
  assert.match(problem, /\/graphql/)
  assert.match(problem, /VITE_GRAPHQL_URL/)
})

test('Supabase認証 + localhost も設定漏れとして知らせる', () => {
  const problem = graphqlEndpointProblem({
    uri: 'http://localhost:3000/graphql',
    useSupabaseAuth: true,
  })
  assert.ok(problem)
  assert.match(problem, /VITE_GRAPHQL_URL/)
})

test('Cognito(AWS本番)では相対パスでも何も言わない', () => {
  // CloudFrontが同じオリジンにまとめているので、相対が正しい設定。
  // ここで警告を出すと、切り替え日まで動く本番に嘘の警告が出続ける
  assert.equal(
    graphqlEndpointProblem({ uri: '/graphql', useSupabaseAuth: false }),
    null,
  )
  assert.equal(
    graphqlEndpointProblem({
      uri: 'http://localhost:3000/graphql',
      useSupabaseAuth: false,
    }),
    null,
  )
})

test('Supabase認証 + Cloud Runの絶対URLなら何も言わない', () => {
  assert.equal(
    graphqlEndpointProblem({
      uri: 'https://manualy-api-xxxx.us-west1.run.app/graphql',
      useSupabaseAuth: true,
    }),
    null,
  )
})

// --- 大13: JSONでない応答を静かに通さない ---

test('JSONとみなす種別', () => {
  assert.equal(isJsonLikeContentType('application/json'), true)
  assert.equal(isJsonLikeContentType('application/json; charset=utf-8'), true)
  // GraphQL over HTTP の正式な種別。弾くと正しい構成が全部止まる
  assert.equal(isJsonLikeContentType('application/graphql-response+json'), true)
  assert.equal(isJsonLikeContentType('multipart/mixed; boundary=-'), true)
})

test('SPAのindex.htmlはJSONとみなさない', () => {
  assert.equal(isJsonLikeContentType('text/html; charset=utf-8'), false)
  assert.equal(isJsonLikeContentType(null), false)
  assert.equal(isJsonLikeContentType(''), false)
})

test('JSONでない応答の文言に、宛先とHTMLであることが出る', () => {
  const message = nonJsonResponseMessage(
    '/graphql',
    200,
    'text/html; charset=utf-8',
  )
  // 「Unexpected token '<'」だけだと、どこへ送って何が返ったのか分からない
  assert.match(message, /\/graphql/)
  assert.match(message, /text\/html/)
  assert.match(message, /index\.html/)
  assert.match(message, /VITE_GRAPHQL_URL/)
})

test('宛先違いのエラーは名前で見分けられる', () => {
  const error = new GraphQLEndpointError('だめでした')
  assert.equal(error.name, GRAPHQL_ENDPOINT_ERROR_NAME)
  assert.ok(error instanceof Error)
})
