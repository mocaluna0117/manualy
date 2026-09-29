-- RAG検索の性能対策。Prismaのスキーマでは表現できない型/演算子のため生SQLで追加する。

-- 1) ベクトル検索(意味の近さ)用のHNSWインデックス。
--    無いと毎回の質問で全チャンクの距離計算+ソート(全表スキャン)になる。
--    vector_cosine_ops は検索側が使うコサイン距離演算子(<=>)に対応する。
CREATE INDEX IF NOT EXISTS "ManualChunk_embedding_hnsw_idx"
  ON "ManualChunk" USING hnsw (embedding vector_cosine_ops);

-- 2) キーワード一致(ILIKE '%...%')用のGINインデックス。
--    前後にワイルドカードが付く部分一致はB-treeでは使えないため、
--    pg_trgm(3文字単位の分割)を使って高速化する。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "ManualChunk_content_trgm_idx"
  ON "ManualChunk" USING gin (content gin_trgm_ops);

-- 3) キーワード検索はマニュアルのタイトル・ファイル名も対象にしているので同様に張る
CREATE INDEX IF NOT EXISTS "Manual_title_trgm_idx"
  ON "Manual" USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Manual_file_name_trgm_idx"
  ON "Manual" USING gin (file_name gin_trgm_ops);

-- 4) 検索は取り込み完了済みのみを対象にするため、その絞り込みも効かせる
CREATE INDEX IF NOT EXISTS "Manual_ingest_status_idx"
  ON "Manual" (ingest_status);
