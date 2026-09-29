-- フォルダの並び順(管理者がドラッグで入れ替える)。
--
-- 注意: prisma migrate dev は生SQLのインデックス(HNSW/pg_trgm)への
-- DROP文を自動生成してくる。必ず--create-onlyで生成し、DROP INDEXを
-- 削除してから適用すること(20260811125037のコメントも参照)。

-- AlterTable
ALTER TABLE "ManualCategory" ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "ManualCategory_sort_order_name_idx" ON "ManualCategory"("sort_order", "name");

-- 既存フォルダには現在の表示順(名前順)をそのまま初期値として入れる。
-- 全部0のままだと同値になり、並び替え前後で順序が不安定に見えるため
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY name) AS rn FROM "ManualCategory"
)
UPDATE "ManualCategory" c SET sort_order = ordered.rn
FROM ordered WHERE c.id = ordered.id;
