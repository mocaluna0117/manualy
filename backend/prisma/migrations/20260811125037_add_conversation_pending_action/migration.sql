-- チャット経由の管理操作(全マニュアル再分類など)の「確認待ち」状態を持つ列。
--
-- 注意: prisma migrate dev はスキーマに書けない生SQLのインデックス
-- (20260727234701_add_search_indexes のHNSW/pg_trgm)を「ドリフト」とみなして
-- DROP文を自動生成してくる。生成されたマイグレーションからDROP INDEXを
-- 必ず削除すること(消えると検索が全表スキャンになり事実上停止する)。
ALTER TABLE "Conversation" ADD COLUMN     "pending_action" JSONB;
