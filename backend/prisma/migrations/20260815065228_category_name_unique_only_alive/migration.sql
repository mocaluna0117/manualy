-- フォルダ名の一意制約を「生きているフォルダの中だけ」に変える。
--
-- 全体で一意だと、ゴミ箱に入れたフォルダが名前を占有し続けてしまう。
-- その状態でAIの再分類が同じ名前のフォルダを作ろうとしても作れず、
-- 対象のマニュアルが未分類のまま残っていた(ゴミ箱がマニュアル側の
-- 動きに干渉していた)。部分インデックスにすることで、ゴミ箱の中身は
-- 生きている側から完全に切り離される。
--
-- 注意: prisma migrate devが生成するSQLには、生SQLで作った
-- 検索用インデックス(pg_trgm / HNSW)のDROPが混ざる。消すと本番の
-- 検索が黙って壊れるため、この変更だけを残して手で書いている。
DROP INDEX "ManualCategory_name_key";

CREATE UNIQUE INDEX "ManualCategory_name_alive_key"
  ON "ManualCategory" (name)
  WHERE deleted_at IS NULL;
