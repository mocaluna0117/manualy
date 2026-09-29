/*
  Warnings:

  - You are about to drop the column `fileKey` on the `Manual` table. All the data in the column will be lost.
  - You are about to drop the column `mimeType` on the `Manual` table. All the data in the column will be lost.
  - Added the required column `file_key` to the `Manual` table without a default value. This is not possible if the table is not empty.
  - Added the required column `file_name` to the `Manual` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Manual" DROP COLUMN "fileKey",
DROP COLUMN "mimeType",
ADD COLUMN     "file_key" TEXT NOT NULL,
ADD COLUMN     "file_name" TEXT NOT NULL,
ADD COLUMN     "mime_type" TEXT NOT NULL DEFAULT 'application/pdf';
