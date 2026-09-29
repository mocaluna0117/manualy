#!/usr/bin/env bash
# backend と rag を Cloud Run(米国オレゴン)へ出す。
#
#   ./scripts/deploy-cloudrun.sh              # ビルドから全部
#   ./scripts/deploy-cloudrun.sh --skip-build # 既にあるイメージで出し直すだけ
#
# 2026-09-10 に実際に通した手順をそのまま固めたもの。当日ゼロから組み立てない。
#
# ■ なぜ2回デプロイするのか(鶏と卵)
#   backend は自分のURL(INTERNAL_BASE_URL)を Cloud Tasks の宛先に使うが、
#   Cloud Run は自分のURLを教えてくれない。初回は URL が分からないので、
#   INGEST_DISPATCH=cloud_tasks を付けると起動ガードに弾かれて上がらない。
#   → 1回目は inline で出してURLを確定させ、2回目で cloud_tasks に切り替える。
#   サービスが既にある場合はURLが分かるので1回で済ませる。
#
# ■ rag を --allow-unauthenticated にする理由
#   手順書は当初 --no-allow-unauthenticated(IAM認証)を指示していたが、
#   backend は rag を呼ぶとき Google のIDトークンを取らない(共有トークンだけ)。
#   そのままだと全部403で検索もチャットも取り込みも死ぬ。実装を足すのは切り替え後にする。
#   入口は RAG_API_TOKEN で守る(rag/security.py は未設定なら全部503にする fail-closed)。
set -euo pipefail
export PATH="/opt/homebrew/share/google-cloud-sdk/bin:/opt/homebrew/bin:$PATH"

P=todoapp0117
R=us-west1
REG=$R-docker.pkg.dev/$P/manualy
SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"

# ■ イメージのタグ
#   タグは「イメージの中身」に付ける名前。作業ツリーが汚れたままビルドすると、
#   中身はコミットと違うのに v<コミット> という名前が付き、**いま動いている
#   イメージを同じタグで上書きする**。こうなるとタグを指定した切り戻しができない。
#   → 汚れているときは自動で -dirty を付け、コミットのタグを踏まないようにする。
#     確認待ちで止めないのは、当日は未コミットのまま出す場面が普通にあり、
#     急いでいる手を止めるほうが事故に近いから。ただし**黙っては進めない**。
#   見るのは Cloud Build に送る backend/ と rag/ だけ。docs を直しただけで
#   毎回 -dirty になると警告が意味を失う(イメージの中身は変わらないため)。
#   --skip-build のときも同じ規則。タグが常にツリーの状態を表すので、
#   -dirty のイメージがまだ無ければ deploy が落ちる(黙って別の中身を出すよりよい)。
SHA="$(git rev-parse --short HEAD)"
DIRTY="$(git status --porcelain -- backend rag)"
if [ -z "${TAG:-}" ]; then
  if [ -n "$DIRTY" ]; then TAG="v$SHA-dirty"; else TAG="v$SHA"; fi
fi
if [ -n "$DIRTY" ]; then
  echo "!! backend/ か rag/ に未コミットの変更があります(イメージはコミットと違う中身になります)"
  printf '%s\n' "$DIRTY" | sed 's/^/     /'
  case "$TAG" in
    *-dirty) echo "   → タグは ${TAG}。v${SHA}(いま動いているイメージ)は上書きしません" ;;
    *)       echo "   → タグは ${TAG}。**既にあるイメージなら中身を上書きします。**違うなら Ctrl-C" ;;
  esac
  echo "   コミットしてから出し直すなら、いったん Ctrl-C"
  echo
fi

set -a; . ./.env.migration; set +a
: "${CF_ACCOUNT_ID:?.env.migration に CF_ACCOUNT_ID がありません}"
: "${R2_S3_ENDPOINT:?.env.migration に R2_S3_ENDPOINT がありません}"

url_of() { gcloud run services describe "$1" --project=$P --region=$R --format="value(status.url)" 2>/dev/null || true; }

if [ "$SKIP_BUILD" = "0" ]; then
  echo "== 1/5 イメージをビルド(Cloud Build。手元のDockerは不要、443だけで通る) =="
  gcloud builds submit backend --tag="$REG/backend:$TAG" --project=$P --region=$R
  gcloud builds submit rag     --tag="$REG/rag:$TAG"     --project=$P --region=$R
else
  echo "== 1/5 ビルドは飛ばす(TAG=$TAG) =="
  case "$TAG" in
    *-dirty) echo "   (-dirty のイメージは汚れたツリーでビルドしたときだけあります。"
             echo "    無ければ次の deploy が「イメージが見つからない」で止まります)" ;;
  esac
fi

echo "== 2/5 rag を出す =="
# メモリはAWSと同じ1GB。書き起こしはページ画像を4並列でレンダリングするので
# 既定の512MiBだとOOMで落ちる。同時実行も4に絞る(既定80だと1インスタンスに詰め込みすぎる)
gcloud run deploy manualy-rag --image="$REG/rag:$TAG" --project=$P --region=$R \
  --platform=managed --allow-unauthenticated \
  --memory=1Gi --cpu=1 --concurrency=4 --max-instances=2 --min-instances=0 --cpu-boost \
  --timeout=1800 \
  --update-secrets=/etc/secrets/app.json=manualy-rag:latest \
  --set-env-vars="^@^SECRETS_FILE=/etc/secrets/app.json@DATABASE_SSL_CA=/app/certs/supabase-ca.crt@EMBEDDING_PROVIDER=workers_ai@ANSWER_PROVIDER=workers_ai@EMBEDDING_COLUMN=embedding_v2@RAG_ALLOWED_DOWNLOAD_HOSTS=${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --quiet >/dev/null
RAG_URL="$(url_of manualy-rag)"
echo "   rag: $RAG_URL"

echo "== 3/5 backend を出す =="
BE_URL="$(url_of manualy-backend)"
COMMON_ENV="SECRETS_FILE=/etc/secrets/app.json@DATABASE_SSL_CA=/app/certs/supabase-ca.crt@AUTH_PROVIDER=supabase@RAG_SERVICE_URL=$RAG_URL@RECLASSIFY_STORE=db@FRONTEND_ORIGIN=https://manualy.pages.dev@S3_ENDPOINT=$R2_S3_ENDPOINT@S3_PUBLIC_ENDPOINT=$R2_S3_ENDPOINT@S3_BUCKET=$R2_BUCKET@S3_REGION=auto@S3_FORCE_PATH_STYLE=true@INQUIRY_MAIL=off"
deploy_backend() {  # $1 = INGEST_DISPATCH の設定ぶん
  gcloud run deploy manualy-backend --image="$REG/backend:$TAG" --project=$P --region=$R \
    --platform=managed --allow-unauthenticated \
    --memory=512Mi --cpu=1 --concurrency=40 --max-instances=2 --min-instances=0 --cpu-boost \
    --timeout=1800 \
    --update-secrets=/etc/secrets/app.json=manualy-backend:latest \
    --set-env-vars="^@^${COMMON_ENV}@$1" --quiet >/dev/null
}
if [ -z "$BE_URL" ]; then
  echo "   初回なので、まず inline で出してURLを確定させる"
  deploy_backend "INGEST_DISPATCH=inline"
  BE_URL="$(url_of manualy-backend)"
  echo "   backend: $BE_URL"
fi
echo "   cloud_tasks に切り替えて出し直す"
deploy_backend "INGEST_DISPATCH=cloud_tasks@INTERNAL_BASE_URL=$BE_URL@GCP_TASKS_QUEUE=manualy-ingest@GCP_TASKS_RECLASSIFY_QUEUE=manualy-reclassify@GCP_PROJECT_ID=$P@GCP_REGION=$R"
echo "   backend: $BE_URL"

echo "== 4/5 動いているか確かめる =="
fail() { echo "NG: $1" >&2; exit 1; }
# /healthz は使わない。Google のインフラが横取りしてコンテナに届かない(2026-09-10 実測)
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BE_URL/health")"  = "200" ] || fail "backend の /health が 200 を返さない"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$RAG_URL/health")" = "200" ] || fail "rag の /health が 200 を返さない"
# 守りが効いているか(素通しになっていたら止める)
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$RAG_URL/search" -H 'content-type: application/json' -d '{"question":"x"}')" = "401" ] \
  || fail "rag がトークン無しの検索を受け付けてしまう"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BE_URL/internal/ingest" -H 'content-type: application/json' -d '{}')" = "401" ] \
  || fail "backend の内部エンドポイントが素通しになっている"
echo "   OK: 両方 /health が200 / 未認証は401"

echo "== 5/5 起動ログに設定漏れの警告が出ていないか =="
gcloud run services logs read manualy-backend --project=$P --region=$R --limit=40 2>/dev/null \
  | grep -iE "WARN|Error" | grep -v "GET 200" | tail -5 || echo "   警告なし"

echo
echo "完了"
echo "  backend : $BE_URL"
echo "  rag     : $RAG_URL"
echo "  画面を出すには: ./scripts/deploy-pages.sh $BE_URL"
