#!/usr/bin/env bash
# AWS(RDS)のバックアップを Supabase に流し込む。リハーサル(D1)も本番(D5)も同じ手順。
#
#   SUPABASE_DB_URL='postgresql://postgres.xxx:PASS@aws-0-us-west-1.pooler.supabase.com:5432/postgres' \
#   ./scripts/restore-to-supabase.sh ~/manual-search-backups/<日時>/database.dump --yes
#
# やること(順番が大事):
#   1. 拡張 vector / pg_trgm を public に作る(ダンプも Prisma の移行も public 前提。
#      Supabase の画面から作ると extensions スキーマに入り、<=> や gin_trgm_ops が見えなくなる)
#   2. Supabase 側にあるアプリの表と型を全部落とす(Supabase は DB を作り直せないため)
#   3. pg_restore でフル復元(--data-only は使わない。FK の順序が保証されず、
#      _prisma_migrations も二重になる。verify-backup.sh の復元訓練と同じ流儀にする)
#      ダンプ内の CREATE EXTENSION は 1 で作ってあるので除いて流す
#   4. prisma migrate deploy で、AWS 側にまだ当てていない移行(embedding_v2 など)だけを当てる
#      (migrate dev は絶対に使わない。手書きの HNSW/pg_trgm 索引に DROP を生成する)
#   5. 索引の本数と各表の件数を出す。verify-backup.sh の出力と見比べる
#
# 事故防止: 接続先が Supabase 以外なら止まる。--yes が無いと何もしない(中身を全部消すため)
set -euo pipefail
# Supabase は PostgreSQL 17。クライアントは「復元先のバージョン」に合わせる。
# 17 のクライアントは 16 で取ったダンプも読める(逆は読めない)
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:$PATH"

DUMP="${1:-}"
CONFIRM="${2:-}"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL を設定してください(Session pooler / 5432 の接続文字列)}"

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "使い方: $0 <database.dump> --yes" >&2; exit 2
fi
case "$SUPABASE_DB_URL" in
  *supabase.co*|*supabase.com*) ;;
  *) echo "NG: 接続先が Supabase ではありません。AWS や手元のDBを消さないために止めます" >&2; exit 2;;
esac
if [ "$CONFIRM" != "--yes" ]; then
  echo "この操作は Supabase 側のアプリの表を全部消して入れ直します。よければ --yes を付けてください" >&2
  exit 2
fi
if ! pg_restore --version | grep -q " 17\."; then
  echo "NG: pg_restore 17 が要ります(brew install postgresql@17)。" >&2
  echo "    復元先の Supabase が PostgreSQL 17 なので、クライアントも合わせる" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 証明書があれば相手が本物の Supabase か検証して繋ぐ。
# 無ければ暗号化だけ(sslmode=require 相当)で進む
CA="$ROOT/supabase-ca.crt"
if [ -f "$CA" ]; then
  case "$SUPABASE_DB_URL" in
    *\?*) SUPABASE_DB_URL="${SUPABASE_DB_URL}&sslmode=verify-full&sslrootcert=$CA";;
    *)    SUPABASE_DB_URL="${SUPABASE_DB_URL}?sslmode=verify-full&sslrootcert=$CA";;
  esac
  echo "(証明書で接続先を検証します: supabase-ca.crt)"
fi
PSQL="psql $SUPABASE_DB_URL -v ON_ERROR_STOP=1 -q"

echo "== 1/5 拡張を public に作る =="
$PSQL -c 'CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;'
$PSQL -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;'

echo "== 2/5 アプリの表と型を落とす =="
# ダンプの TOC から表と型の名前を取る(手で列挙すると新しい表を忘れる)
TABLES=$(pg_restore -l "$DUMP" | awk '/ TABLE public /{print $6}' | sort -u)
TYPES=$(pg_restore -l "$DUMP" | awk '/ TYPE public /{print $6}' | sort -u)
for t in $TABLES ReclassifyJob; do   # ReclassifyJob は移行で作る表。前回のリハの残りがあれば消す
  $PSQL -c "DROP TABLE IF EXISTS public.\"$t\" CASCADE;"
done
for ty in $TYPES; do
  $PSQL -c "DROP TYPE IF EXISTS public.\"$ty\" CASCADE;"
done
echo "  表 $(echo $TABLES | wc -w | tr -d ' ') 個・型 $(echo $TYPES | wc -w | tr -d ' ') 個を落としました"

echo "== 3/5 フル復元 =="
TOC="$(mktemp)"
# 拡張は 1 で作ったので、ダンプ側の CREATE EXTENSION / COMMENT ON EXTENSION は流さない
pg_restore -l "$DUMP" | grep -v -E ' (EXTENSION|COMMENT) - ' > "$TOC"
pg_restore --no-owner --no-acl -L "$TOC" -d "$SUPABASE_DB_URL" "$DUMP"
rm -f "$TOC"
echo "  復元完了"

echo "== 4/5 未適用の移行を当てる(migrate deploy) =="
( cd "$ROOT/backend" && DATABASE_URL="$SUPABASE_DB_URL" npx prisma migrate deploy 2>&1 | grep -v "openssl\|Prisma failed to detect" | tail -6 )

echo "== 5/5 確認 =="
echo "-- 検索用の索引(HNSW は旧+新で2本、GIN は3本あるはず)"
$PSQL -tA -c "select indexname from pg_indexes where schemaname='public' and (indexdef ilike '%hnsw%' or indexdef ilike '%gin_trgm%') order by 1" | sed 's/^/   /'
echo "-- 各表の件数(verify-backup.sh の値と見比べる)"
for t in $TABLES; do
  n=$($PSQL -tA -c "select count(*) from public.\"$t\"")
  printf '   %-22s %s\n' "$t" "$n"
done
echo "-- ベクトル"
echo "   embedding 有り: $($PSQL -tA -c 'select count(*) from "ManualChunk" where embedding is not null') 件 / embedding_v2 有り: $($PSQL -tA -c 'select count(*) from "ManualChunk" where embedding_v2 is not null') 件"
echo "-- 適用済みの移行(末尾3件)"
$PSQL -tA -c 'select migration_name from "_prisma_migrations" order by finished_at desc nulls last limit 3' | sed 's/^/   /'
echo "完了"
