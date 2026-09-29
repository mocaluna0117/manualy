-- 「マニュアルから答えられたか」を回答ごとに記録する列。
--
-- これまでは citations が空かどうかしか手がかりが無かったが、それは
-- 管理操作の応答・権限案内・生成エラーとも重なるため、答えられなかった
-- 質問を後から数えることができなかった。AIが申告する「[参照] なし」を
-- そのまま保存し、「どの領域のマニュアルが足りないか」を集計できるようにする。
--
-- nullを許すのは、判断材料が無い場合(管理操作の応答・エラー・この列より
-- 前に保存されたデータ)を「答えられなかった」に混ぜないため。
--
-- 注意: prisma migrate devが生成するSQLには、生SQLで作った検索用
-- インデックス(pg_trgm / HNSW)のDROPが必ず混ざる。消すと本番の検索が
-- 黙って壊れるため、このALTER TABLEだけを残して手で書いている。
ALTER TABLE "Message" ADD COLUMN "answered_from_manuals" BOOLEAN;

-- 集計は「期間で絞って新しい順」に引くので、日時の索引を足しておく
CREATE INDEX "Message_created_at_idx" ON "Message" (created_at);
