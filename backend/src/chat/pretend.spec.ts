import { pretendNotes } from './pretend';

/**
 * 「やったフリ」の注意書き。
 *
 * 出さなすぎると、やっていない操作を終わったと思わせてしまう。
 * 出しすぎると、それ自体が混乱の元になる(実際に2件の指摘を受けた)。
 * 報告された場面をそのまま固定しておく。
 */

const base = { calledTools: [] as string[], hasOptions: false };

describe('本当にやっていないときは伝える', () => {
  it('移動したと書いたのにツールを呼んでいない', () => {
    const notes = pretendNotes({
      ...base,
      modelText: '「顛末書」を「施工」フォルダに移動しました。',
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('実際には移動していません');
  });

  it('聞き返している最中でも、完了を主張したなら伝える', () => {
    // 「やりました」は事実と違うので、選択肢があっても見逃さない
    const notes = pretendNotes({
      ...base,
      hasOptions: true,
      modelText: '移動しました。ほかにもありますか？',
    });
    expect(notes).toHaveLength(1);
  });

  it('これからやると言ったきり何もしていない', () => {
    const notes = pretendNotes({
      ...base,
      modelText: '「A」フォルダを削除します。',
    });
    expect(notes[0]).toContain('実際には削除していません');
  });

  it('ルールの登録・フォルダの作成・名前の変更も見る', () => {
    expect(
      pretendNotes({ ...base, modelText: '分類ルールを登録しました。' })[0],
    ).toContain('ルールは登録されていません');
    expect(
      pretendNotes({
        ...base,
        modelText: '「安全」フォルダを作成しました。',
      })[0],
    ).toContain('フォルダは作成されていません');
    expect(
      pretendNotes({
        ...base,
        modelText: 'フォルダ名を「安全書類」に変更しました。',
      })[0],
    ).toContain('名前は変わっていません');
  });
});

describe('やったときは何も言わない', () => {
  it('ツールを呼んでいれば注意しない', () => {
    expect(
      pretendNotes({
        ...base,
        calledTools: ['move_manual'],
        modelText: '「顛末書」を移動しました。',
      }),
    ).toEqual([]);
  });
});

describe('報告された、余計な注意書きを出さない', () => {
  it('システムが書いた成功メッセージには反応しない', () => {
    // 実際の不具合: delete_folderは成功しているのに、システムが書いた
    // 「ゴミ箱に移動しました」を拾って「実際には移動していません」と付けていた。
    // モデル自身の文だけを見るので、システムの文は渡ってこない
    const notes = pretendNotes({
      ...base,
      calledTools: ['delete_folder'],
      modelText:
        '福祉住環境対応フォルダ内のPDFを福祉住環境コーディネーターフォルダへ移動し、元のフォルダを削除します。',
    });
    expect(notes).toEqual([]);
  });

  it('どれを移動するか聞き返しているときは注意しない', () => {
    // 実際の不具合: 選択肢を出して聞き返しているのに
    // 「実際には移動していません」と付けていた(読めば分かる)
    const notes = pretendNotes({
      ...base,
      hasOptions: true,
      modelText:
        '施工マニュアルを施工マニュアルフォルダへ移動します。\n\nどの施工マニュアルを移動したいですか？',
    });
    expect(notes).toEqual([]);
  });

  it('問いかけで終わっていれば、選択肢が無くても注意しない', () => {
    const notes = pretendNotes({
      ...base,
      modelText: 'どのフォルダへ移動しますか？',
    });
    expect(notes).toEqual([]);
  });

  it('「移動できます」のような案内は完了の主張ではない', () => {
    expect(
      pretendNotes({
        ...base,
        modelText: '一覧画面でドラッグすると移動できます。',
      }),
    ).toEqual([]);
  });

  it('「移動する方法を説明します」も完了の主張ではない', () => {
    expect(
      pretendNotes({
        ...base,
        modelText: 'マニュアルを移動する方法を説明します。',
      }),
    ).toEqual([]);
  });

  it('ほかの操作が成功していれば、宣言だけの部分は蒸し返さない', () => {
    const notes = pretendNotes({
      ...base,
      calledTools: ['create_folder'],
      modelText: 'フォルダを作成し、マニュアルを移動します。',
    });
    expect(notes).toEqual([]);
  });

  it('空の応答では何も出さない', () => {
    expect(pretendNotes({ ...base, modelText: '   ' })).toEqual([]);
  });
});
