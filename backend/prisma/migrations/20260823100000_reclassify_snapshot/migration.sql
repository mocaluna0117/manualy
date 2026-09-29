-- 再分類を元に戻せるようにするための控え。
--
-- AIの再分類は一度に何十件も動かすので、思っていたのと違う結果になったとき
-- 手で戻すのは現実的でない。動かす前の分類を記録しておき、まとめて戻せるようにする。
--
-- entries には「動いたマニュアルだけ」を入れる:
--   [{ "manualId": "...", "before": "カテゴリID または null", "after": "..." }]
-- after を持つのは、戻すときに「その後に人が手で動かしたもの」を巻き込まないため。
-- 今の分類が after と違うマニュアルは、人が動かしたものとみなして触らない。
--
-- 注意: prisma migrate devが生成するSQLには、生SQLで作った検索用
-- インデックス(pg_trgm / HNSW)のDROPが必ず混ざる。消すと本番の検索が
-- 黙って壊れるため、必要な文だけを残して手で書いている。
CREATE TABLE "ReclassifySnapshot" (
  "id" TEXT NOT NULL,
  -- どの操作か。ALL=全件再分類 / SELECTED=選んだ分 / UNCATEGORIZED=未分類をまとめて
  "kind" TEXT NOT NULL,
  "entries" JSONB NOT NULL,
  -- この再分類でAIが新しく作ったフォルダの名前。戻すと空になるので画面で知らせる
  "created_categories" JSONB,
  "moved_count" INTEGER NOT NULL,
  "undone_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReclassifySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReclassifySnapshot_created_at_idx" ON "ReclassifySnapshot"("created_at");
