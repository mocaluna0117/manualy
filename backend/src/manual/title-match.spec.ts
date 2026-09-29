import { looseMatch, squeezeTitle } from './title-match';

/**
 * 題名の突き合わせ。
 *
 * AIが渡してくる題名は実際の題名と空白の入り方が違うことがあり、
 * そのままの部分一致だと外れて「見つかりませんでした」で終わっていた
 * (実際に、全角空白で区切られた題名で失敗した報告があった)。
 * その形を固定しておく。
 */

const manual = (title: string) => ({ title });

describe('squeezeTitle', () => {
  it('全角と半角の空白を無くして比べられる形にする', () => {
    expect(squeezeTitle('ベルックス\u3000FSタイプ\u3000施工説明書')).toBe(
      squeezeTitle('ベルックス FSタイプ 施工説明書'),
    );
  });

  it('全角英数は半角に揃える', () => {
    expect(squeezeTitle('ＦＳタイプ')).toBe('fsタイプ');
  });

  it('大文字小文字を区別しない', () => {
    expect(squeezeTitle('YKK AP')).toBe(squeezeTitle('ykk\u3000ap'));
  });
});

describe('looseMatch', () => {
  const all = [
    manual('ベルックス FSタイプ 施工説明書'),
    manual('クロゼットお手入れ（ストッパーの仕様、調整方法）'),
    manual('木質フローリング 施工説明書'),
    manual('屋根 施工説明書'),
  ];

  it('空白の入り方が違うだけなら「同じもの」として返す', () => {
    // AIが全角空白で区切ってきても、実際の資料に辿り着ける
    const { same, similar } = looseMatch(
      'ベルックス\u3000FSタイプ\u3000施工説明書',
      all,
    );
    expect(same.map((m) => m.title)).toEqual([
      'ベルックス FSタイプ 施工説明書',
    ]);
    expect(similar).toEqual([]);
  });

  it('題名の一部でも「同じもの」として返す', () => {
    const { same } = looseMatch('クロゼットお手入れ', all);
    expect(same).toHaveLength(1);
  });

  it('ぴったり無いときは、長い語で候補を出す', () => {
    // 「ベルックス」は1件しか無いが、語で探せば施工説明書が3件見つかる
    const { same, similar } = looseMatch('施工説明書 一式', all);
    expect(same).toEqual([]);
    expect(similar.map((m) => m.title)).toEqual([
      'ベルックス FSタイプ 施工説明書',
      '木質フローリング 施工説明書',
      '屋根 施工説明書',
    ]);
  });

  it('長い語から順に試す(短い語で広く拾いすぎない)', () => {
    const { similar } = looseMatch('屋根 施工説明書', all);
    // 「施工説明書」(5文字)より「屋根」(2文字)が短いので、まず長い方で探す
    expect(similar.every((m) => m.title.includes('施工説明書'))).toBe(true);
  });

  it('かすりもしないときは何も返さない', () => {
    const { same, similar } = looseMatch('存在しない資料', all);
    expect(same).toEqual([]);
    expect(similar).toEqual([]);
  });

  it('空文字では何も返さない(全件を候補にしない)', () => {
    expect(looseMatch('   ', all)).toEqual({ same: [], similar: [] });
  });

  it('候補は上限で打ち切る', () => {
    const many = Array.from({ length: 30 }, (_, i) => manual(`手順書${i}`));
    expect(looseMatch('手順書', many).same).toHaveLength(10);
  });

  it('1文字の語では探さない(広く拾いすぎるため)', () => {
    const { similar } = looseMatch('あ い', all);
    expect(similar).toEqual([]);
  });
});
