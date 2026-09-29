#!/usr/bin/env bash
# 手元のバックアップが本当に復元できるかを確かめる(復元訓練)。
#
#   ./scripts/verify-backup.sh <database.dump へのパス>
#
# 復元したことのないバックアップは、バックアップとは呼べない。
# ここでは実際に pg_restore で別のデータベースへ流し込み、
# 稼働中のDBと件数を突き合わせて、欠けが無いことを確認する。
#
# 本番のデータベースには触らない。RDSの同じインスタンス上に
# restore_drill という捨てるためのDBを作り、確認後に削除する。
# (手元にPostgreSQLを入れなくても済むよう、ECSの単発タスクで実行する)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

DUMP_PATH="${1:-}"
[ -n "$DUMP_PATH" ] || { echo "使い方: $0 <database.dump>" >&2; exit 1; }
[ -s "$DUMP_PATH" ] || { echo "エラー: $DUMP_PATH がありません" >&2; exit 1; }

REGION="${AWS_REGION:-ap-northeast-1}"
CLUSTER="manual-search"
TASKDEF="manual-search-backend"
PG_MAJOR=16

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31mエラー: %s\033[0m\n' "$*" >&2; exit 1; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="manual-search-manuals-$ACCOUNT"
KEY="_backup/verify-$(date +%s).dump"

log "バックアップをアップロードする ($(du -h "$DUMP_PATH" | cut -f1))"
aws s3 cp "$DUMP_PATH" "s3://$BUCKET/$KEY" --region "$REGION" --only-show-errors

cleanup() { aws s3 rm "s3://$BUCKET/$KEY" --region "$REGION" >/dev/null 2>&1 || true; }
trap cleanup EXIT

NET_JSON="$(aws ecs describe-services --cluster "$CLUSTER" --services backend \
  --region "$REGION" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)"

REMOTE_SCRIPT=$(cat <<'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates >/dev/null
. /etc/os-release
echo "deb http://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
apt-get update -qq
apt-get install -y -qq "postgresql-client-${PG_MAJOR}" >/dev/null

node -e 'import("@aws-sdk/client-s3").then(async (m) => {
  const fs = await import("fs");
  const c = new m.S3Client({ region: process.env.S3_REGION });
  const r = await c.send(new m.GetObjectCommand({
    Bucket: process.env.S3_BUCKET, Key: process.env.DUMP_KEY,
  }));
  fs.writeFileSync("/tmp/db.dump", Buffer.from(await r.Body.transformToByteArray()));
  console.log("DOWNLOAD_OK");
}).catch((e) => { console.error("DOWNLOAD_FAIL", e.message); process.exit(1); })'

export PGSSLMODE=verify-full PGSSLROOTCERT="$DATABASE_SSL_CA"
BASE="${DATABASE_URL%%\?*}"
DRILL="${BASE%/*}/restore_drill"

psql "$BASE" -v ON_ERROR_STOP=1 -q -c 'DROP DATABASE IF EXISTS restore_drill'
psql "$BASE" -v ON_ERROR_STOP=1 -q -c 'CREATE DATABASE restore_drill'

# 拡張の所有者に関する警告は出るが、データが入れば目的は達している。
# 成否は後段の件数の一致で判断する
pg_restore --no-owner --no-acl -d "$DRILL" /tmp/db.dump 2>&1 | tail -8 || true

for t in Manual ManualChunk ManualCategory User Conversation Message Inquiry; do
  a=$(psql "$BASE"  -tAc "select count(*) from \"$t\"" 2>/dev/null || echo NA)
  b=$(psql "$DRILL" -tAc "select count(*) from \"$t\"" 2>/dev/null || echo NA)
  if [ "$a" = "$b" ]; then echo "OK    $t 稼働中=$a 復元後=$b"
  else echo "DIFF  $t 稼働中=$a 復元後=$b"; fi
done

# ベクトルは移行の要。次元数と件数が保たれているかを見る
echo "VEC 次元=$(psql "$DRILL" -tAc 'select vector_dims(embedding) from "ManualChunk" where embedding is not null limit 1')"
echo "VEC 件数=$(psql "$DRILL" -tAc 'select count(*) from "ManualChunk" where embedding is not null') (稼働中=$(psql "$BASE" -tAc 'select count(*) from "ManualChunk" where embedding is not null'))"
# 検索用の索引が復元されたか(HNSW と pg_trgm)
echo "IDX $(psql "$DRILL" -tAc "select count(*) from pg_indexes where schemaname='public' and (indexdef ilike '%hnsw%' or indexdef ilike '%gin%')") 本 (稼働中=$(psql "$BASE" -tAc "select count(*) from pg_indexes where schemaname='public' and (indexdef ilike '%hnsw%' or indexdef ilike '%gin%')") 本)"

psql "$BASE" -v ON_ERROR_STOP=1 -q -c 'DROP DATABASE restore_drill'
echo DRILL_DONE
REMOTE
)

OVERRIDES="$(python3 - "$REMOTE_SCRIPT" "$KEY" "$PG_MAJOR" <<'PY'
import json, sys
script, key, pg_major = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({"containerOverrides": [{
    "name": "backend",
    "command": ["sh", "-c", script],
    "environment": [
        {"name": "DUMP_KEY", "value": key},
        {"name": "PG_MAJOR", "value": pg_major},
    ],
}]}))
PY
)"

log "復元訓練を実行する(数分かかります)"
TASK_ARN="$(aws ecs run-task --cluster "$CLUSTER" --region "$REGION" \
  --task-definition "$TASKDEF" --launch-type FARGATE \
  --network-configuration "{\"awsvpcConfiguration\":$NET_JSON}" \
  --overrides "$OVERRIDES" --query 'tasks[0].taskArn' --output text)"
TASK_ID="${TASK_ARN##*/}"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION"

LOGS="$(aws logs get-log-events --region "$REGION" \
  --log-group-name "/ecs/$CLUSTER/backend" \
  --log-stream-name "ecs/backend/$TASK_ID" --start-from-head \
  --query 'events[].message' --output text | tr '\t' '\n')"

log "結果"
printf '%s\n' "$LOGS" | grep -E '^(OK|DIFF|VEC|IDX|DOWNLOAD|pg_restore|DRILL_DONE)' || printf '%s\n' "$LOGS" | tail -20

if printf '%s' "$LOGS" | grep -q DRILL_DONE && ! printf '%s' "$LOGS" | grep -q '^DIFF'; then
  printf '\n\033[32m復元できることを確認しました。件数もすべて一致しています。\033[0m\n'
else
  die "復元訓練に問題があります(上の出力を確認してください)"
fi
