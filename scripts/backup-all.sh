#!/usr/bin/env bash
# AWSにある全データを手元に取り出す。
#
#   ./scripts/backup-all.sh [出力先ディレクトリ]
#   既定の出力先: ~/manual-search-backups/<YYYY-MM-DD-HHMM>
#
# なぜ必要か: 無料クレジットが尽きるとアカウントは自動的に閉鎖され、
# 90日後にデータは完全に消える。移行が間に合わなくても資産を失わないよう、
# いつでも全部を手元に落とせる状態を保つ。
#
# 取り出すもの
#   1. データベース全体   … pg_dump のカスタム形式(pg_restoreで復元可)
#   2. マニュアルのPDF等  … S3バケットの中身をそのまま
#   3. 利用者一覧         … Cognitoのユーザー(パスワードは取り出せない仕様)
#   4. 構成の控え         … タスク定義・サービス設定・CloudFront・Cognitoの設定
#
# DBはVPCの中にあり手元から直接繋がらないので、ECSの単発タスクで
# pg_dump を実行してS3に置き、それを落としてからS3側を消す。
set -euo pipefail

# HomebrewのawsコマンドがPATHに無い環境でも動くようにする
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REGION="${AWS_REGION:-ap-northeast-1}"
CLUSTER="manual-search"
TASKDEF="manual-search-backend"
PG_MAJOR=16 # RDSのPostgreSQLと合わせる(pg_dumpはサーバ以上の版が必要)

STAMP="$(date +%Y-%m-%d-%H%M)"
OUT_DIR="${1:-$HOME/manual-search-backups/$STAMP}"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31mエラー: %s\033[0m\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || die "aws コマンドが見つかりません"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" ||
  die "AWSの認証情報が使えません(aws configure を確認)"

BUCKET_MANUALS="manual-search-manuals-$ACCOUNT"
DUMP_KEY="_backup/db-$STAMP.dump"

mkdir -p "$OUT_DIR"
log "出力先: $OUT_DIR (アカウント $ACCOUNT / $REGION)"

# ---------------------------------------------------------------------------
# 1. データベース
# ---------------------------------------------------------------------------
log "1/4 データベースを書き出す(ECSの単発タスク)"

# 稼働中のサービスからネットワーク設定を借りる(サブネットIDを埋め込まない)
NET_JSON="$(aws ecs describe-services --cluster "$CLUSTER" --services backend \
  --region "$REGION" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)"
[ "$NET_JSON" != "null" ] || die "backendサービスのネットワーク設定が読めません"

# タスクの中で動かす手順。
# DATABASE_URL の ?schema=public は libpq が解釈できないため落とす。
# TLSはRDSのCAを明示して検証まで行う(暗号化だけでなく相手の確認もする)。
REMOTE_SCRIPT=$(cat <<'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates >/dev/null
. /etc/os-release
# Debianの既定のpostgresql-clientは版が古いことがあるので、本家リポジトリから
# サーバと同じメジャー版を入れる(pg_dumpがサーバより古いと実行を拒否される)
echo "deb http://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
apt-get update -qq
apt-get install -y -qq "postgresql-client-${PG_MAJOR}" >/dev/null
export PGSSLMODE=verify-full PGSSLROOTCERT="$DATABASE_SSL_CA"
pg_dump --no-owner --no-acl --format=custom --file=/tmp/db.dump "${DATABASE_URL%%\?*}"
echo "DUMP_BYTES=$(stat -c %s /tmp/db.dump)"
node -e 'import("@aws-sdk/client-s3").then(async (m) => {
  const fs = await import("fs");
  const c = new m.S3Client({ region: process.env.S3_REGION });
  await c.send(new m.PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: process.env.DUMP_KEY,
    Body: fs.readFileSync("/tmp/db.dump"),
  }));
  console.log("UPLOAD_OK");
}).catch((e) => { console.error("UPLOAD_FAIL", e.message); process.exit(1); })'
REMOTE
)

OVERRIDES="$(python3 - "$REMOTE_SCRIPT" "$DUMP_KEY" "$PG_MAJOR" <<'PY'
import json, sys
script, dump_key, pg_major = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({"containerOverrides": [{
    "name": "backend",
    "command": ["sh", "-c", script],
    "environment": [
        {"name": "DUMP_KEY", "value": dump_key},
        {"name": "PG_MAJOR", "value": pg_major},
    ],
}]}))
PY
)"

TASK_ARN="$(aws ecs run-task --cluster "$CLUSTER" --region "$REGION" \
  --task-definition "$TASKDEF" --launch-type FARGATE \
  --network-configuration "{\"awsvpcConfiguration\":$NET_JSON}" \
  --overrides "$OVERRIDES" \
  --query 'tasks[0].taskArn' --output text)"
[ -n "$TASK_ARN" ] && [ "$TASK_ARN" != "None" ] || die "タスクを起動できませんでした"
TASK_ID="${TASK_ARN##*/}"
echo "タスク $TASK_ID の完了を待ちます(数分かかります)"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION"

EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --region "$REGION" --query 'tasks[0].containers[0].exitCode' --output text)"
LOGS="$(aws logs get-log-events --region "$REGION" \
  --log-group-name "/ecs/$CLUSTER/backend" \
  --log-stream-name "ecs/backend/$TASK_ID" --start-from-head \
  --query 'events[].message' --output text 2>/dev/null || true)"

if [ "$EXIT_CODE" != "0" ] || ! printf '%s' "$LOGS" | grep -q UPLOAD_OK; then
  printf '%s\n' "$LOGS" | tr '\t' '\n' | tail -20
  die "データベースの書き出しに失敗しました(終了コード $EXIT_CODE)"
fi
printf '%s\n' "$LOGS" | tr '\t' '\n' | grep -E 'DUMP_BYTES|UPLOAD_OK' || true

aws s3 cp "s3://$BUCKET_MANUALS/$DUMP_KEY" "$OUT_DIR/database.dump" --region "$REGION"
# 手元に降りたら、置きっぱなしにしない(マニュアル用のバケットなので)
aws s3 rm "s3://$BUCKET_MANUALS/$DUMP_KEY" --region "$REGION" >/dev/null
[ -s "$OUT_DIR/database.dump" ] || die "落としたダンプが空です"

# ---------------------------------------------------------------------------
# 2. マニュアルのファイル
# ---------------------------------------------------------------------------
log "2/4 マニュアルのファイルを同期する"
mkdir -p "$OUT_DIR/manuals"
aws s3 sync "s3://$BUCKET_MANUALS/" "$OUT_DIR/manuals/" --region "$REGION" \
  --exclude "_backup/*" --only-show-errors
echo "$(find "$OUT_DIR/manuals" -type f | wc -l | tr -d ' ') 個のファイル"

# ---------------------------------------------------------------------------
# 3. 利用者
# ---------------------------------------------------------------------------
log "3/4 利用者一覧を書き出す"
POOL_ID="$(aws ecs describe-task-definition --task-definition "$TASKDEF" \
  --region "$REGION" \
  --query "taskDefinition.containerDefinitions[0].environment[?name=='COGNITO_USER_POOL_ID'].value | [0]" \
  --output text)"
# パスワードは仕様上取り出せない。移行後は会社のMicrosoftアカウントで入るため不要
aws cognito-idp list-users --user-pool-id "$POOL_ID" --region "$REGION" \
  --output json > "$OUT_DIR/cognito-users.json"
python3 - "$OUT_DIR/cognito-users.json" <<'PY'
import json, sys
users = json.load(open(sys.argv[1]))["Users"]
print(f"{len(users)} 人")
PY

# ---------------------------------------------------------------------------
# 4. 構成の控え
# ---------------------------------------------------------------------------
log "4/4 構成の控えを保存する"
CONF="$OUT_DIR/config"
mkdir -p "$CONF"
save() { # save <ファイル名> <awsコマンド...>
  local name="$1"; shift
  if "$@" --region "$REGION" --output json > "$CONF/$name" 2>/dev/null; then
    echo "  $name"
  else
    echo "  $name (取得できず)"; rm -f "$CONF/$name"
  fi
}
for svc in backend rag; do
  save "taskdef-$svc.json" aws ecs describe-task-definition --task-definition "manual-search-$svc"
done
save "services.json" aws ecs describe-services --cluster "$CLUSTER" --services backend rag
save "cognito-pool.json" aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID"
save "cognito-client.json" aws cognito-idp describe-user-pool-client --user-pool-id "$POOL_ID" \
  --client-id 7lnm9n6l4rmnb5qol93ujiagi2
save "rds.json" aws rds describe-db-instances --db-instance-identifier manual-search-db
save "s3-cors.json" aws s3api get-bucket-cors --bucket "$BUCKET_MANUALS"
DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[0].Id" --output text 2>/dev/null || true)"
if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
  save "cloudfront.json" aws cloudfront get-distribution-config --id "$DIST_ID"
fi

# ---------------------------------------------------------------------------
# 目録
# ---------------------------------------------------------------------------
{
  echo "# バックアップ $STAMP"
  echo
  echo "取得元: AWSアカウント $ACCOUNT / $REGION"
  echo "取得日時: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo
  echo "## 中身"
  echo
  echo "- database.dump … pg_dumpのカスタム形式(RDSのPostgreSQL $PG_MAJOR で取得)"
  echo '  **Supabase へ戻すときは `scripts/restore-to-supabase.sh` を使う。**'
  echo '  素の `pg_restore` を手で打たない(前処理と順番がある)。'
  echo
  echo '  ```'
  echo '  set -a; . ./.env.migration; set +a     # SUPABASE_DB_URL が入る'
  echo '  ./scripts/restore-to-supabase.sh <このフォルダ>/database.dump --yes'
  echo '  ```'
  echo
  echo '  スクリプトの中身: 拡張(vector・pg_trgm)を public に作る → アプリの表と型を'
  echo '  全部落とす → **フル** pg_restore → prisma migrate deploy →'
  echo '  索引(HNSW 2本・pg_trgm GIN 3本)と各表の件数を表示。'
  echo '  最後に出る件数は `scripts/verify-backup.sh` の値と見比べる。'
  echo
  echo '  - **`--data-only` は使わない。** FKの順序が保証されず、`_prisma_migrations` が'
  echo '    二重になる(docs/b-plan-implementation-handbook.md 「6. データ移行の手順」)。'
  echo '  - `pg_restore` は**復元先**に合わせて 17 が要る(Supabase は PostgreSQL 17.6)。'
  echo '    スクリプトが版を確かめ、17 でなければ止まる。'
  echo
  echo "- manuals/ … S3バケットの中身(PDF・チャット添付画像)"
  echo "- cognito-users.json … 利用者一覧。パスワードは仕様上含まれない"
  echo "- config/ … 現行構成の控え(復旧や移行の参照用)"
  echo
  echo "## サイズと照合値"
  echo
  echo '```'
  ( cd "$OUT_DIR" && du -sh database.dump manuals config 2>/dev/null )
  echo
  ( cd "$OUT_DIR" && shasum -a 256 database.dump )
  echo '```'
} > "$OUT_DIR/MANIFEST.md"

log "完了"
du -sh "$OUT_DIR"
echo "目録: $OUT_DIR/MANIFEST.md"
