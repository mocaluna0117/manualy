-- 分類ルール(AIに教える自然文の辞書)と、手動分類のピン留め列。
--
-- 注意: prisma migrate dev は生SQLのインデックス(HNSW/pg_trgm)への
-- DROP文を自動生成してくる。必ず--create-onlyで生成し、DROP INDEXを
-- 削除してから適用すること(20260811125037のコメントも参照)。

-- AlterTable
ALTER TABLE "Manual" ADD COLUMN     "category_pinned" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ClassificationRule" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassificationRule_pkey" PRIMARY KEY ("id")
);
