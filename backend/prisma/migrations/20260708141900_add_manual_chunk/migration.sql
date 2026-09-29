-- pgvector拡張を有効化(シャドウDBやまっさらなDBでも再現できるように)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "ManualChunk" (
    "id" TEXT NOT NULL,
    "manual_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualChunk_manual_id_chunk_index_key" ON "ManualChunk"("manual_id", "chunk_index");

-- AddForeignKey
ALTER TABLE "ManualChunk" ADD CONSTRAINT "ManualChunk_manual_id_fkey" FOREIGN KEY ("manual_id") REFERENCES "Manual"("id") ON DELETE CASCADE ON UPDATE CASCADE;
