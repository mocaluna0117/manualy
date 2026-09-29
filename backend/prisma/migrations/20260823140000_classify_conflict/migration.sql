-- 分類ルールが食い違ったマニュアルの保留。
--
-- 「クロゼット関連は建具・内装対応へ」と「※〇〇と併用する と書かれたものは
-- 共通アフター対応マニュアルへ」の両方に当てはまるファイルは、どちらが正しいかを
-- AIに決めさせるべきではない。行き先を決めずに候補だけ持ち、利用者に選んでもらう。
-- 選ぶまでは動かさない(勝手に動かないので、選び忘れても実害が出ない)。
--
-- 注意: prisma migrate devが生成するSQLには、生SQLで作った検索用
-- インデックス(pg_trgm / HNSW)のDROPが必ず混ざる。消すと本番の検索が
-- 黙って壊れるため、必要な文だけを残して手で書いている。
CREATE TABLE "ClassifyConflict" (
  "id" TEXT NOT NULL,
  "manual_id" TEXT NOT NULL,
  -- 行き先の候補(フォルダ名の配列)
  "candidates" JSONB NOT NULL,
  -- 選んで解決した時刻。nullならまだ保留中
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ClassifyConflict_pkey" PRIMARY KEY ("id")
);

-- 同じマニュアルの保留は1件だけにする(再分類のたびに積み上がらないように)
CREATE UNIQUE INDEX "ClassifyConflict_manual_id_key" ON "ClassifyConflict"("manual_id");
CREATE INDEX "ClassifyConflict_resolved_at_idx" ON "ClassifyConflict"("resolved_at");

ALTER TABLE "ClassifyConflict" ADD CONSTRAINT "ClassifyConflict_manual_id_fkey"
  FOREIGN KEY ("manual_id") REFERENCES "Manual"("id") ON DELETE CASCADE ON UPDATE CASCADE;
