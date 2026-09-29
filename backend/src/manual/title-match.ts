/**
 * 題名の突き合わせ。
 *
 * AIが指定してくる題名は、実際の題名と空白の入り方が違うことがある
 * (「ベルックス(全角空白区切り)FSタイプ 施工説明書」のように全角空白で区切ってくる等)。
 * そのままの部分一致だと外れて「見つかりませんでした」で終わってしまうので、
 * 空白を詰めて比べ直し、それでも当たらなければ語ごとに候補を出す。
 */

/** 比べるための正規化。全角/半角の違いと空白を無くし、大文字小文字も揃える */
export function squeezeTitle(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export interface LooseMatch<T> {
  /** 空白の違いだけとみなせるもの(同じ資料を指していると考えてよい) */
  same: T[];
  /** 語の一部が一致するだけのもの(利用者に選んでもらう候補) */
  similar: T[];
}

/**
 * 部分一致で見つからなかったときに、近いものを探す。
 *
 * @param needle AIが指定してきた題名
 * @param all    生きているマニュアル(件数は数百なので全件を見て構わない)
 */
export function looseMatch<T extends { title: string }>(
  needle: string,
  all: T[],
  limit = 10,
): LooseMatch<T> {
  const target = squeezeTitle(needle);
  if (!target) return { same: [], similar: [] };

  // 空白を詰めれば含まれる = 同じ資料を指していると考えてよい
  const same = all.filter((m) => squeezeTitle(m.title).includes(target));
  if (same.length > 0) return { same: same.slice(0, limit), similar: [] };

  // 語ごとに分けて、長い語から探す。
  // 「ベルックス FSタイプ 施工説明書」なら「施工説明書」で拾えることを狙う
  const words = [
    ...new Set(
      needle
        .split(/[\s\u3000]+/)
        .map(squeezeTitle)
        .filter((w) => w.length >= 2),
    ),
  ].sort((a, b) => b.length - a.length);

  for (const word of words) {
    const hits = all.filter((m) => squeezeTitle(m.title).includes(word));
    if (hits.length > 0) return { same: [], similar: hits.slice(0, limit) };
  }
  return { same: [], similar: [] };
}
