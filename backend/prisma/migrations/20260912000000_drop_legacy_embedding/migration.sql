-- 旧 embedding 列(Bedrock Titan Embeddings V2)と、その HNSW 索引を落とす。
--
-- なぜ落とすか:
--   2026-09-11 に検索を bge-m3(Workers AI)の embedding_v2 へ切り替え、
--   2026-09-12 に AWS を完全撤収した。Bedrock が使えなくなったので、
--   この列のベクトルと比べられる問い合わせベクトルはもう作れない。
--   持っていても使い道が無く、Supabase の無料枠(500MB)を約50MB食う
--   (索引32MB + 列18MB。実測でDB全体147MBの3分の1)。
--
-- 戻せないこと:
--   Titan のベクトルは再生成できない。必要になったら
--   ~/manual-search-backups/2026-09-11-2337/database.dump から復元するしかない。
--   ただし比較対象の検索精度は測ってあり、新しいほうが良い
--   (Hit@1 71%→79% / MRR 0.76→0.81。2026-09-11 実測)。
--
-- 注意: prisma migrate dev は使っていない。生成されるSQLには、生SQLで作った
-- 検索用インデックス(pg_trgm / HNSW)の DROP が必ず混ざるため、手で書いている。

DROP INDEX IF EXISTS "ManualChunk_embedding_hnsw_idx";

ALTER TABLE "ManualChunk" DROP COLUMN IF EXISTS "embedding";
