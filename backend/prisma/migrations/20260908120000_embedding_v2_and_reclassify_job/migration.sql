-- B案(Cloudflare Workers AI / Cloud Run)への移行で必要になる2つ。
--
-- 注意: prisma migrate devが生成するSQLには、生SQLで作った検索用
-- インデックス(pg_trgm / HNSW)のDROPが必ず混ざる。消すと本番の検索が
-- 黙って壊れるため、必要な文だけを残して手で書いている。

-- 1) bge-m3 の埋め込みを入れる新しい列。
--    Titan V2 と同じ1024次元だが別のモデルなので、既存の embedding 列を
--    上書きしてはいけない(途中で混ざると検索が静かに壊れる)。
--    新列に全件入れ終わってから rag の EMBEDDING_COLUMN を切り替え、
--    動作確認のあとで旧列と旧索引を落とす。
ALTER TABLE "ManualChunk" ADD COLUMN "embedding_v2" vector(1024);

-- 新列の近傍検索用インデックス。空の列に作っても一瞬で終わる。
-- 全件を入れ終わったあとは REINDEX で作り直す(大量更新後の定石)
CREATE INDEX IF NOT EXISTS "ManualChunk_embedding_v2_hnsw_idx"
  ON "ManualChunk" USING hnsw (embedding_v2 vector_cosine_ops);

-- 2) 全件再分類の進み具合。インスタンス内のメモリから表へ移す。
--    Cloud Run は複数に増えるので、別のインスタンスに当たると
--    「動いていない」と返して進捗表示が壊れる。最新の1行を読む
CREATE TABLE "ReclassifyJob" (
  "id" TEXT NOT NULL,
  "running" BOOLEAN NOT NULL,
  "moved_count" INTEGER NOT NULL DEFAULT 0,
  "created_categories" JSONB NOT NULL DEFAULT '[]',
  "emptied_categories" JSONB NOT NULL DEFAULT '[]',
  "moved_to_locked" JSONB NOT NULL DEFAULT '[]',
  "skipped_locked" JSONB NOT NULL DEFAULT '[]',
  "conflicted_count" INTEGER NOT NULL DEFAULT 0,
  "instruction" TEXT,
  "conversation_id" TEXT,
  "error" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),

  CONSTRAINT "ReclassifyJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReclassifyJob_started_at_idx" ON "ReclassifyJob"("started_at");
