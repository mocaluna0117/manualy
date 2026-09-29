-- 回答への評価(人の判断)を記録する列。
--
-- これまでの answered_from_manuals は、AIが自分で申告した「抜粋を根拠にしたか」
-- しか見ていない。根拠はあっても知りたいことに答えていない回答は拾えず、
-- 申告そのものが漏れることもある(実データで16件中1件)。
-- 人が押した評価を別に持ち、集計ではそちらを優先する。
--
-- feedback_reason は👎のときだけ聞く任意の理由。「マニュアルが無い」のか
-- 「内容が古い」のかで、次にやることが変わるため。
--
-- 注意: prisma migrate devが生成するSQLには、生SQLで作った検索用
-- インデックス(pg_trgm / HNSW)のDROPが必ず混ざる。消すと本番の検索が
-- 黙って壊れるため、必要な文だけを残して手で書いている。
CREATE TYPE "MessageFeedback" AS ENUM ('GOOD', 'BAD');

ALTER TABLE "Message" ADD COLUMN "feedback" "MessageFeedback";
ALTER TABLE "Message" ADD COLUMN "feedback_reason" TEXT;
