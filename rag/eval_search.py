"""検索品質の評価ハーネス。

eval_dataset.jsonl の質問を実際の検索パイプライン(クエリ拡張 → 埋め込み →
ハイブリッド検索)に通し、期待するマニュアルが上位に出るかを測る。
検索ロジックを変える前と後で実行し、精度の変化を感覚でなく数字で確認するためのもの。

データセットの1行 = 1ケース:
  {"question": "質問文", "expect": ["タイトルの部分一致candidates"], "note": "説明"}
expect のどれかを含むタイトルのマニュアルが検索結果に出れば正解(any-of)。
expect に合うマニュアルがDBに1件も無いケースはSKIP(環境によって
マニュアル構成が違っても、同じデータセットを使い回せるようにするため)。

実行: cd rag && .venv/bin/python eval_search.py
  --no-rewrite でクエリ拡張(Bedrock呼び出し)を省略できる。安く決定的になるが、
  本番の検索経路とは変わる点に注意。
"""

import argparse
import json
import re
from pathlib import Path

import main
from embedding import to_vector_literal

DATASET_PATH = Path(__file__).parent / "eval_dataset.jsonl"


def load_dataset() -> list[dict]:
    cases = []
    with open(DATASET_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                cases.append(json.loads(line))
    return cases


def expected_manual_exists(cur, patterns: list[str]) -> bool:
    """expectに合うマニュアルがこの環境に存在するか(無ければSKIP対象)"""
    any_match = " OR ".join(["title ILIKE %s"] * len(patterns))
    cur.execute(
        f'SELECT 1 FROM "Manual" WHERE ingest_status = \'COMPLETED\' AND ({any_match}) LIMIT 1',
        [f"%{p}%" for p in patterns],
    )
    return cur.fetchone() is not None


def first_hit_rank(rows, patterns: list[str]) -> int | None:
    """検索結果の中で、期待マニュアルが最初に出てくる順位(1始まり)"""
    for rank, (_mid, title, _content, _page) in enumerate(rows, start=1):
        if any(p in title for p in patterns):
            return rank
    return None


def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-rewrite", action="store_true", help="クエリ拡張を省略する")
    args = parser.parse_args()

    cases = load_dataset()
    results = []  # (rank | None) 評価対象のみ
    skipped = 0

    print(f"{'順位':>4}  質問")
    print("-" * 60)
    with main.db_connect() as conn:
        with conn.cursor() as cur:
            for case in cases:
                patterns = case["expect"]
                if not expected_manual_exists(cur, patterns):
                    skipped += 1
                    print(f"SKIP  {case['question']}  (期待マニュアルがこの環境に無い)")
                    continue

                query = case["question"]
                if not args.no_rewrite:
                    try:
                        query = main.answer_generator.rewrite_query(case["question"], [])
                    except Exception:
                        pass  # 本番と同じく、拡張に失敗したら元の質問で続行

                terms = [t for t in re.split(r"\s+", query) if len(t) >= 2][:10]
                query_vec = to_vector_literal(main.embedder.embed_texts([query])[0])
                rows = main.hybrid_search(cur, query_vec, terms)

                rank = first_hit_rank(rows, patterns)
                results.append(rank)
                mark = f"{rank:>4}" if rank else "  ✗ "
                print(f"{mark}  {case['question']}")

    evaluated = len(results)
    if evaluated == 0:
        print("\n評価できるケースがありません")
        return

    hit_at = lambda k: sum(1 for r in results if r and r <= k) / evaluated  # noqa: E731
    # MRR: 正解が1位なら1.0、2位なら0.5…の平均。「どれだけ上位に出せたか」の代表値
    mrr = sum(1.0 / r for r in results if r) / evaluated

    print("-" * 60)
    print(f"評価 {evaluated}件 (SKIP {skipped}件)")
    print(f"Hit@1: {hit_at(1):.0%}   Hit@3: {hit_at(3):.0%}   Hit@8: {hit_at(8):.0%}   MRR: {mrr:.2f}")


if __name__ == "__main__":
    run()
