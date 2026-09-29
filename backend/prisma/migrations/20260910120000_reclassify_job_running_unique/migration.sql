-- 全件再分類を「同時に1本だけ」にする最後の砦。
--
-- 注意: prisma migrate devは使っていない。生成されるSQLには、生SQLで作った
-- 検索用インデックス(pg_trgm / HNSW)のDROPが必ず混ざるため、必要な文だけを
-- 手で書いている。Prismaのスキーマ言語には部分インデックス(WHERE付き)の
-- 書き方が無いので、いずれにせよここに書くしかない。
--
-- アプリ側は助言ロック(pg_advisory_xact_lock)で直列化しているが、それは
-- 「このアプリを通った挿入」にしか効かない。psqlや別のスクリプトから直接
-- 入れられると running=true が2行並び、
--   - 進捗表示(最新1行を読む)がどちらを指すか分からなくなる
--   - 控え(ReclassifySnapshot)も2つできて「元に戻す」が当てにならなくなる
-- という壊れ方をする。DB側でも1本に制限しておく。
--
-- 部分索引(WHERE running)にするのは、終わった行(running=false)は
-- いくつでも残ってよいため。列全体にUNIQUEを張ると2件目の完了で失敗する。
CREATE UNIQUE INDEX IF NOT EXISTS "ReclassifyJob_running_key"
  ON "ReclassifyJob"("running")
  WHERE "running";
