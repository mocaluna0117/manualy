-- フォルダを作ったのがAIの自動分類かどうかを記録する。
--
-- 再分類で空になったフォルダを片付けるとき、利用者が自分で作った箱を
-- うっかり消さないよう区別するために使う。
--
-- 既定値をfalseにしてあるのは安全側に倒すため。今後もし設定を書き忘れた
-- 経路が増えても「消してよい候補」には入らない。AIが作る経路
-- (applyAssignments)だけが明示的にtrueを入れる。
--
-- そのうえで、この列を足す前からある行は判別する手段が無いため、
-- 一度だけまとめてAI作成として印を付ける。本番の既存フォルダは
-- ほとんどが再分類でAIが作ったものであることを確認済み(利用者と合意)。
--
-- 注意: prisma migrate devが生成するSQLには、生SQLで作った検索用
-- インデックス(pg_trgm / HNSW)のDROPが必ず混ざる。消すと本番の検索が
-- 黙って壊れるため、この2文だけを残して手で書いている。
ALTER TABLE "ManualCategory"
  ADD COLUMN "created_by_ai" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ManualCategory" SET "created_by_ai" = true;
