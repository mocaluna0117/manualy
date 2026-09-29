#!/usr/bin/env bash
# フロントを Cloudflare Pages(無料構成の配信先)へ出す。
#
#   ./scripts/deploy-pages.sh https://manualy-backend-xxxx.us-west1.run.app
#
# AWS向けの scripts/deploy-frontend.sh とは**別物**。**切り替え日にあちらを流さない。**
# 理由は「新環境の値で切り戻し先を上書きしてしまう」ではない。そこはもう塞いである
# (あちらの 41-46行目が VITE_AUTH_PROVIDER を見て cognito 以外なら止め、
#  67-71行目がバンドルの run.app / supabase.co を見て止める)。
# 危ないのは**通ってしまう側**。cognito のままなら検査を全部抜けてしまい、
# 82-87行目の `aws s3 sync --delete` が S3 の中身を「いまの作業ツリーのビルド」で
# 作り直し(distに無いファイルは消える)、90-91行目の
# `create-invalidation --paths '/*'` で CloudFront のキャッシュを全部落とす。
# 凍結して動作を確かめてあるはずの切り戻し先が、誰も確かめていないビルドに入れ替わる。
#
# frontend/.env.production は**書き換えない**。あそこは cognito のままにしておく
# (Gitに入っていて、AWSのビルドもそれを読む。supabase に変えてコミットすると
#  切り替え日まで本番のログインが壊れる)。値はビルド時の環境変数で上書きする。
# Vite は .env より実際の環境変数を優先する。
#
# 上げる前に必ずバンドルを検査する。以前、ローカル用の宛先が入ったまま本番へ出て
# 「ログインは通るのに中身が全部空」になった事故がある(2026-08-23)。
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

BACKEND="${1:-}"
if [ -z "$BACKEND" ]; then
  echo "使い方: $0 <backendのURL>   例: $0 https://manualy-backend-xxxx.us-west1.run.app" >&2
  exit 2
fi
case "$BACKEND" in
  https://*) ;;
  *) echo "NG: https で始まる絶対URLを渡してください(渡された値: $BACKEND)" >&2; exit 2;;
esac
BACKEND="${BACKEND%/}"          # 末尾のスラッシュを落とす
GRAPHQL="$BACKEND/graphql"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a; . ./.env.migration; set +a
: "${CF_API_TOKEN:?.env.migration に CF_API_TOKEN がありません}"
: "${VITE_SUPABASE_URL:=$SUPABASE_URL}"
: "${VITE_SUPABASE_ANON_KEY:=$SUPABASE_ANON_KEY}"

echo "== 1/4 ビルド(認証=supabase / GraphQL=$GRAPHQL) =="
(
  cd frontend
  VITE_AUTH_PROVIDER=supabase \
  VITE_GRAPHQL_URL="$GRAPHQL" \
  VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
  VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY" \
  npm run build
)

BUNDLE="$(ls "$ROOT"/frontend/dist/assets/index-*.js)"
echo "== 2/4 検査: $(basename "$BUNDLE") =="
fail() { echo "NG: $1" >&2; exit 1; }
grep -q "localhost:3000" "$BUNDLE" && fail "ローカル用の宛先が残っている"
grep -q "$GRAPHQL" "$BUNDLE"       || fail "GraphQLの宛先 $GRAPHQL が入っていない"
grep -q "supabase.co"  "$BUNDLE"   || fail "Supabase のURLが入っていない"
# service_role は公開JSに絶対に入れてはいけない。
# **文字列 "sb_secret_" では判定しない。**supabase-js が鍵の種類を見分けるために
# その並びを内部に持っているので、必ず誤検知する(実際にした)。
# 手元の実物の値そのもので照合する。
if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && grep -qF "$SUPABASE_SERVICE_ROLE_KEY" "$BUNDLE"; then
  fail "service_role キーの実物が混ざっている"
fi
# DBの接続文字列(パスワード入り)も同様に確かめる
if [ -n "${SUPABASE_DB_PASSWORD:-}" ] && grep -qF "$SUPABASE_DB_PASSWORD" "$BUNDLE"; then
  fail "DBのパスワードが混ざっている"
fi
if [ -n "${CF_API_TOKEN:-}" ] && grep -qF "$CF_API_TOKEN" "$BUNDLE"; then
  fail "Cloudflare のトークンが混ざっている"
fi
if [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && grep -qF "$R2_SECRET_ACCESS_KEY" "$BUNDLE"; then
  fail "R2 のシークレットが混ざっている"
fi
grep -q "amazoncognito.com" "$BUNDLE" && echo "  注意: Cognito のドメインも残っている(切替用のコードが両方入るため正常)"
echo "  OK: localhost なし / 宛先あり / 手元の秘密(service_role・DBパスワード・CFトークン・R2)はどれも入っていない"

echo "== 3/4 Pages へ公開 =="
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
  npx wrangler pages deploy frontend/dist --project-name=manualy --branch=main --commit-dirty=true

echo "== 4/4 配信の確認 =="
SERVED="$(curl -s https://manualy.pages.dev/ | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1)"
if [ "$SERVED" != "$(basename "$BUNDLE")" ]; then
  echo "NG: 配信中は $SERVED で、上げた $(basename "$BUNDLE") と違う(反映待ちの可能性あり)" >&2
  exit 1
fi
echo "完了: https://manualy.pages.dev で $SERVED を配信中"
echo
echo "※ frontend/dist には supabase 版が残っている。"
echo "   このあと AWS 向けに deploy-frontend.sh を流すときは必ず再ビルドされる(スクリプト内でビルドする)。"
