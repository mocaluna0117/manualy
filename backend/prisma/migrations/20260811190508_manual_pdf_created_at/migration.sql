-- PDF自体が持つ作成日。一覧の「作成日」列に使う(取り込み時に読み取る)。
--
-- 注意: prisma migrate dev は生SQLのインデックス(HNSW/pg_trgm)への
-- DROP文を自動生成してくる。必ず--create-onlyで生成し、DROP INDEXを
-- 削除してから適用すること(20260811125037のコメントも参照)。

-- AlterTable
ALTER TABLE "Manual" ADD COLUMN     "pdf_created_at" TIMESTAMP(3);
