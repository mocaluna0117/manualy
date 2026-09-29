-- チャット入力欄に挿し込める定型文(管理者が編集できる)。
--
-- 注意: prisma migrate dev は生SQLのインデックス(HNSW/pg_trgm)への
-- DROP文を自動生成してくる。必ず--create-onlyで生成し、DROP INDEXを
-- 削除してから適用すること(20260811125037のコメントも参照)。

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptTemplate_sort_order_createdAt_idx" ON "PromptTemplate"("sort_order", "createdAt");

-- 初期テンプレート。〇〇の部分は挿入時に選択状態になるので、そのまま打ち替えられる
INSERT INTO "PromptTemplate" ("id", "title", "body", "sort_order", "updatedAt") VALUES
  (gen_random_uuid()::text, 'お客様対応の相談', 'お客様から「〇〇」という連絡がありました。どのように対応すればよいですか？', 1, now()),
  (gen_random_uuid()::text, '手順を調べる',     '〇〇の手順を教えてください。', 2, now()),
  (gen_random_uuid()::text, '書類の見本を探す', '〇〇の見本・記入例が見たいです。', 3, now()),
  (gen_random_uuid()::text, '有償/無償の判断', '〇〇のケースは有償対応と無償対応のどちらになりますか？判断の根拠も教えてください。', 4, now()),
  (gen_random_uuid()::text, '連絡先を調べる',   '〇〇の担当部署・連絡先を教えてください。', 5, now());
