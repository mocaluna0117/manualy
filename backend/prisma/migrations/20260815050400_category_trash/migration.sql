-- フォルダごとゴミ箱に入れられるようにする。
--
-- 注意: prisma migrate dev は生SQLのインデックス(HNSW/pg_trgm)への
-- DROP文を自動生成してくる。必ず--create-onlyで生成し、DROP INDEXを
-- 削除してから適用すること(20260811125037のコメントも参照)。

-- AlterTable
ALTER TABLE "ManualCategory" ADD COLUMN     "deleted_at" TIMESTAMP(3);
