"""全チャンクを bge-m3(Workers AI)で埋め込み直し、新しい列に入れる。

AIの提供元が Bedrock(Titan V2) から Workers AI(bge-m3) に変わるため、
既存のベクトルは全部作り直す必要がある(同じ1024次元でも別のモデルの値は
比べられない)。本文は ManualChunk.content にあるので PDF の読み直しは不要。

使い方(rag/ で):
    EMBEDDING_PROVIDER=workers_ai CF_ACCOUNT_ID=... CF_API_TOKEN=... \\
    DATABASE_URL=<Supabase> .venv/bin/python reembed_all.py [--reindex]

守ること:
- 既存の embedding 列は上書きしない。新しい列(既定 embedding_v2)にだけ書く。
  途中で混ざると検索が静かに壊れるため、--column embedding は拒否する
- 途中で止まっても、もう一度流せば続きから進む(まだ NULL の行だけを対象にする)
- 埋め込みが壊れていたら(0ベクトル・次元違い)そこで止まる。黙って進めない
- 埋め込む文字列は取り込み時と同じ「タイトル\\n本文」(main.py の /reembed-title と同じ規約)

終わったら --reindex で HNSW 索引を作り直す(大量更新後の定石)。
"""

from __future__ import annotations

import argparse
import os
import sys
import time

# main.py を import すると FastAPI アプリと埋め込みの提供元(EMBEDDING_PROVIDER)が
# 組み立てられる。同じ設定・同じ接続の作り方をそのまま使うためにこうしている
from embedding import to_vector_literal
from main import db_connect, embedder, normalize_text

ALLOWED_TARGETS = ("embedding_v2",)


def count_remaining(cur, column: str) -> tuple[int, int]:
    """(まだ埋め込んでいない件数, 全件数)"""
    cur.execute(
        f'SELECT count(*) FILTER (WHERE {column} IS NULL), count(*) FROM "ManualChunk"'
    )
    remaining, total = cur.fetchone()
    return int(remaining), int(total)


def fetch_batch(cur, column: str, size: int) -> list[tuple[str, str, str]]:
    """まだ埋め込んでいないチャンクを、文書ごとにまとまる順で取り出す"""
    cur.execute(
        f"""
        SELECT c.id, m.title, c.content
        FROM "ManualChunk" c
        JOIN "Manual" m ON m.id = c.manual_id
        WHERE c.{column} IS NULL
        ORDER BY c.manual_id, c.chunk_index
        LIMIT %s
        """,
        (size,),
    )
    return cur.fetchall()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--column", default="embedding_v2", help="書き込む列(既定 embedding_v2)")
    parser.add_argument("--batch", type=int, default=32, help="1回に埋め込む本数")
    parser.add_argument("--limit", type=int, default=0, help="この本数で止める(試し実行用。0=全部)")
    parser.add_argument("--reindex", action="store_true", help="終わったら HNSW 索引を作り直す")
    args = parser.parse_args()

    if args.column not in ALLOWED_TARGETS:
        print(
            f"NG: --column {args.column} には書き込めません。"
            f"既存の embedding 列を上書きしないため、{' / '.join(ALLOWED_TARGETS)} だけを許可しています",
            file=sys.stderr,
        )
        return 2
    provider = os.environ.get("EMBEDDING_PROVIDER", "hashing")
    if provider != "workers_ai":
        print(
            f"NG: EMBEDDING_PROVIDER={provider} です。この列は bge-m3 用なので "
            "workers_ai 以外のベクトルを入れてはいけません",
            file=sys.stderr,
        )
        return 2

    column = args.column
    started = time.monotonic()
    done = 0
    with db_connect() as conn:
        with conn.cursor() as cur:
            remaining, total = count_remaining(cur, column)
        print(f"対象 {remaining} 件 / 全 {total} 件 → 列 {column}")
        if remaining == 0:
            print("すべて埋め込み済みです")
        while remaining > 0:
            with conn.cursor() as cur:
                rows = fetch_batch(cur, column, args.batch)
            if not rows:
                break
            texts = []
            for _id, title, content in rows:
                t = normalize_text(title or "")
                texts.append(f"{t}\n{content}" if t else content)
            # 壊れていれば embedder が例外を投げ、この回は commit されない
            vectors = embedder.embed_texts(texts)
            with conn.cursor() as cur:
                for (chunk_id, _t, _c), vec in zip(rows, vectors):
                    cur.execute(
                        f'UPDATE "ManualChunk" SET {column} = %s::vector WHERE id = %s',
                        (to_vector_literal(vec), chunk_id),
                    )
            conn.commit()  # 1回ぶんを確定。止まっても続きから
            done += len(rows)
            remaining -= len(rows)
            elapsed = time.monotonic() - started
            rate = done / elapsed if elapsed > 0 else 0.0
            eta = remaining / rate if rate > 0 else float("inf")
            print(
                f"  {done} 件済み / 残り {remaining} 件  "
                f"{rate:.1f} 件/秒  残り約 {eta/60:.1f} 分",
                flush=True,
            )
            if args.limit and done >= args.limit:
                print(f"--limit {args.limit} に達したので止めます")
                break

        if args.reindex and remaining == 0:
            index_name = f"ManualChunk_{column}_hnsw_idx"
            print(f"REINDEX {index_name} ...")
            # REINDEX はトランザクションの外で流す
            conn.commit()
            with conn.cursor() as cur:
                cur.execute(f'REINDEX INDEX "{index_name}"')
            conn.commit()
            print("REINDEX 完了")

    print(f"完了: {done} 件を埋め込みました({time.monotonic() - started:.0f} 秒)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
