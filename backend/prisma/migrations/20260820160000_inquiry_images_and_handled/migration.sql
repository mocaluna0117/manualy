-- 問い合わせをアプリの画面で確認できるようにするための2列。
--
-- これまで問い合わせを見る手段はメールだけで、しかも添付した画像は
-- メールにしか載せずDBに残していなかった。メールを見落とすと
-- 「うまくいかない画面」の写真ごと辿れなくなるため、次を足す。
--
-- image_keys … 添付画像の置き場所(S3のキー)。Messageと同じ持ち方
-- handled_at … 対応済みにした時刻。未対応の件数をサイドバーに出すのに使う
--
-- 注意: prisma migrate devが生成するSQLには、生SQLで作った検索用
-- インデックス(pg_trgm / HNSW)のDROPが必ず混ざる。消すと本番の検索が
-- 黙って壊れるため、必要な文だけを残して手で書いている。
ALTER TABLE "Inquiry" ADD COLUMN "image_keys" JSONB;
ALTER TABLE "Inquiry" ADD COLUMN "handled_at" TIMESTAMP(3);
