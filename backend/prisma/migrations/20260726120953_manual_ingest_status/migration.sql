-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Manual" ADD COLUMN     "chunk_count" INTEGER,
ADD COLUMN     "ingest_error" TEXT,
ADD COLUMN     "ingest_status" "IngestStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "ingested_at" TIMESTAMP(3);
