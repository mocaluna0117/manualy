#!/usr/bin/env bash
# フロントを **AWS の本番(S3 + CloudFront)** へ出す。
#
#   ./scripts/deploy-frontend.sh
#
# **これはAWS専用。Cloudflare Pages へ出すときは scripts/deploy-pages.sh を使う。**
# 2026-09-16 の切り替え以降、AWSは「切り戻し先」として残す。ここに新環境
# (Supabase認証 / Cloud RunのURL)のビルドを上げてしまうと、
# **切り戻し先そのものが壊れて、戻る場所が無くなる。**
# frontend/.env.production を supabase に書き換えたあとにうっかり流しても
# 止まるよう、下の「検証」で宛先と認証方式を確かめている。
#
# 手で `npm run build` して `aws s3 sync` すると、2つの事故が起きた:
#
#   1. ローカル開発用の .env(VITE_GRAPHQL_URL=http://localhost:3000/graphql)
#      のままビルドして本番へ上げた。ログインはCognitoが直接処理するので通り、
#      バックエンドに触る処理だけが全部 ERR_CONNECTION_REFUSED になる。
#      画面は「マニュアルもフォルダも0件・管理者でもない」ように見え、
#      データが消えたようにしか見えなかった(2026-08-23)
#   2. 素の `aws s3 sync` はCache-Controlを付けないので、
#      index.htmlが長く残って古いJSを掴み続ける
#
# どちらも「上げる前に確かめる」で防げるので、ここに固定した。
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

BUCKET=manual-search-frontend-271357390238
DISTRIBUTION=E1RJTGF8IYA944
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/frontend/dist"

fail() { echo "NG: $1" >&2; shift; for l in "$@"; do echo "    $l" >&2; done; exit 1; }

# ---- ビルド前: 認証方式を確かめる ----------------------------------------
# Vite は .env.production より「実際の環境変数」を優先する。両方を見て、
# 実際にビルドに効く値を出す(コード側の既定も cognito。frontend/src/lib/auth.ts)。
ENVFILE="$ROOT/frontend/.env.production"
FILE_PROVIDER="$(sed -n 's/^[[:space:]]*VITE_AUTH_PROVIDER[[:space:]]*=[[:space:]]*//p' "$ENVFILE" \
  | tail -1 | tr -d "\"' \r")"
PROVIDER="${VITE_AUTH_PROVIDER:-${FILE_PROVIDER:-cognito}}"
if [ "$PROVIDER" != "cognito" ]; then
  fail "認証方式が cognito ではなく $PROVIDER になっている。" \
       "AWS の本番は Cognito のまま。ここに Supabase 版を上げると切り戻し先が壊れる。" \
       "Cloudflare Pages へ出したいなら ./scripts/deploy-pages.sh <backendのURL> を使うこと。" \
       "($ENVFILE の VITE_AUTH_PROVIDER と、シェルの環境変数の両方を確認)"
fi
echo "認証方式: $PROVIDER(AWS本番)"

echo "== ビルド =="
# .env.production が VITE_GRAPHQL_URL=/graphql を渡す(Viteは.envより優先する)
(cd "$ROOT/frontend" && npm run build)

# 前のビルドが残っていると検証が別のファイルを見てしまう。1個であることを確かめる
if [ "$(ls -1 "$DIST"/assets/index-*.js | wc -l)" -ne 1 ]; then
  fail "$DIST/assets に index-*.js が1個ではない。" "古いビルドが残っている。dist を消してから流し直すこと。"
fi
BUNDLE="$(ls "$DIST"/assets/index-*.js)"
echo "== 検証: $(basename "$BUNDLE") =="

# 開発用の宛先が混ざっていたら、ここで止める
grep -q "localhost:3000" "$BUNDLE" && fail "ビルドに localhost:3000 が入っている。" \
  "$ENVFILE の VITE_GRAPHQL_URL を確認すること。"

# 新環境(無料構成)の値が混ざっていたら止める。**ここが切り戻し先を守る要**。
# cognito でビルドすると Supabase 側のコードは丸ごと落ちるので、
# 正しいAWS版のバンドルに supabase.co は1つも入らない(実測で確認済み)。
grep -q "run\.app" "$BUNDLE" && fail "ビルドに Cloud Run の宛先(run.app)が入っている。" \
  "$ENVFILE の VITE_GRAPHQL_URL が新環境向けに書き換わっている。" \
  "AWS は /graphql(同一オリジンの相対パス)のまま。Pages は ./scripts/deploy-pages.sh。"
grep -q "supabase\.co" "$BUNDLE" && fail "ビルドに Supabase のURLが入っている(= Supabase認証のビルド)。" \
  "これを CloudFront に上げると切り戻し先が壊れる。Pages は ./scripts/deploy-pages.sh。"

# 宛先と認証設定が実際に入っているかも確かめる(空文字で通ってしまわないように)
grep -q "/graphql" "$BUNDLE" || fail "GraphQLの宛先がビルドに見当たらない。"
grep -q "amazoncognito.com" "$BUNDLE" || fail "Cognito のドメインがビルドに入っていない。" \
  "$ENVFILE の VITE_COGNITO_DOMAIN を確認すること(空だとログインできない)。"
echo "OK: localhost なし / run.app なし / supabase.co なし / /graphql あり / Cognito あり"

# ファイル名にハッシュが入るassetsだけ長期キャッシュ。
# index.htmlやアイコンは名前が変わらないので、毎回確認させる
echo "== アップロード(assets: 長期キャッシュ) =="
aws s3 sync "$DIST/assets/" "s3://$BUCKET/assets/" \
  --cache-control "public, max-age=31536000, immutable" --delete

echo "== アップロード(index.html等: no-cache) =="
aws s3 sync "$DIST/" "s3://$BUCKET/" --exclude "assets/*" \
  --cache-control "no-cache" --delete

echo "== キャッシュの無効化 =="
ID="$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths '/*' --query 'Invalidation.Id' --output text)"
aws cloudfront wait invalidation-completed \
  --distribution-id "$DISTRIBUTION" --id "$ID"

echo "== 配信の確認 =="
SERVED="$(curl -s "https://d3r3bcg6d6aepn.cloudfront.net/" |
  grep -o 'index-[A-Za-z0-9_-]*\.js')"
if [ "$SERVED" != "$(basename "$BUNDLE")" ]; then
  echo "NG: 配信中は $SERVED で、上げた $(basename "$BUNDLE") と違う。" >&2
  exit 1
fi
echo "完了: $SERVED を配信中"
