#!/usr/bin/env bash
# 壊れると痛いところのテストをまとめて回す。
#
#   ./scripts/test.sh
#
# バックエンドはjest、RAG(Python)はDockerの中のpytestで動かす。
# Pythonの依存(psycopg・fastapi等)を手元に入れなくても済むよう、
# 本番と同じイメージを使って実行する。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== バックエンド (jest) ==="
(cd backend && npx jest "$@")

echo
echo "=== RAG (pytest / Dockerの中で実行) ==="
docker build --quiet -t manual-search-rag-test -f rag/Dockerfile rag >/dev/null
docker run --rm \
  --entrypoint python3 \
  -e DATABASE_URL=postgresql://dummy/dummy \
  -v "$PWD/rag/tests:/app/tests:ro" \
  manual-search-rag-test -m pytest /app/tests -q

echo
echo "すべて通りました"
