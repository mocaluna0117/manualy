import {
  DbUserRow,
  checkWriteTarget,
  decideAbort,
  planReverse,
  planUserIdMigration,
} from './migrate-user-ids';

/**
 * 利用者IDの付け替えの判定。
 *
 * ここを間違えると、切り替えた瞬間に管理者がMEMBERに落ち、
 * 43件の会話が本人からは消えたように見える(会話はUser.idにぶら下がって
 * いるので、別の行ができると前の行ごと見えなくなる)。しかも気づくのは
 * 「9/16 09:00に全員が使い始めてから」なので、取り返す時間が無い。
 *
 * 二度実行しても安全なこと、そして危ない状態では何も書かずに止まることを
 * 固定しておく。書き込みは1トランザクションなので、止めるなら書く前しかない。
 */

const admin: DbUserRow = {
  id: 'db-1',
  email: 'kimura@example-corp.co.jp',
  cognitoSub: 'cognito-admin',
  role: 'ADMIN',
};
const member: DbUserRow = {
  id: 'db-2',
  email: 'sato@example-corp.co.jp',
  cognitoSub: 'cognito-member',
  role: 'MEMBER',
};

describe('planUserIdMigration', () => {
  it('メールアドレスで突き合わせて、新しいIDへの付け替えを組み立てる', () => {
    const plan = planUserIdMigration({
      dbUsers: [admin, member],
      authUsers: [
        { sub: 'supabase-admin', email: 'kimura@example-corp.co.jp' },
        { sub: 'supabase-member', email: 'sato@example-corp.co.jp' },
      ],
    });
    expect(plan.updates).toEqual([
      {
        email: 'kimura@example-corp.co.jp',
        from: 'cognito-admin',
        to: 'supabase-admin',
      },
      {
        email: 'sato@example-corp.co.jp',
        from: 'cognito-member',
        to: 'supabase-member',
      },
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('大文字小文字と前後の空白の違いは吸収する', () => {
    const plan = planUserIdMigration({
      dbUsers: [{ ...admin, email: '  Kimura@Example-Corp.co.JP ' }],
      authUsers: [
        { sub: 'supabase-admin', email: 'kimura@example-corp.co.jp' },
      ],
    });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].to).toBe('supabase-admin');
    expect(plan.createMissing).toEqual([]);
  });

  it('すでに新しいIDになっている行は二度書きしない(再実行しても安全)', () => {
    const plan = planUserIdMigration({
      dbUsers: [{ ...admin, cognitoSub: 'supabase-admin' }],
      authUsers: [
        { sub: 'supabase-admin', email: 'kimura@example-corp.co.jp' },
      ],
    });
    expect(plan.updates).toEqual([]);
    expect(plan.alreadyDone).toEqual([
      { email: 'kimura@example-corp.co.jp', sub: 'supabase-admin' },
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('認証側に居ないDBの人は、消さずにcreateMissingに入れる', () => {
    // 切り替え当日の初回はここが全員ぶん出る(認証側が0人のため)
    const plan = planUserIdMigration({
      dbUsers: [admin, member],
      authUsers: [],
    });
    expect(plan.updates).toEqual([]);
    expect(plan.createMissing).toEqual([
      { email: 'kimura@example-corp.co.jp', currentSub: 'cognito-admin' },
      { email: 'sato@example-corp.co.jp', currentSub: 'cognito-member' },
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('DBに行が無い認証側の利用者は報告するだけ(勝手に作らない・消さない)', () => {
    const plan = planUserIdMigration({
      dbUsers: [admin],
      authUsers: [
        { sub: 'supabase-admin', email: 'kimura@example-corp.co.jp' },
        { sub: 'supabase-ghost', email: 'taikyo@example-corp.co.jp' },
      ],
    });
    expect(plan.unmatchedAuth).toEqual([
      { email: 'taikyo@example-corp.co.jp', sub: 'supabase-ghost' },
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('新しいIDがすでにDBの別人の行に入っていたら中断する', () => {
    // このまま書くとUNIQUE制約(User_cognito_sub_key)で途中で落ち、
    // 半分だけ新IDという最悪の状態になる
    const plan = planUserIdMigration({
      dbUsers: [admin, { ...member, cognitoSub: 'supabase-admin' }],
      authUsers: [
        { sub: 'supabase-admin', email: 'kimura@example-corp.co.jp' },
      ],
    });
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0].kind).toBe('sub-owned-by-other');
    expect(plan.blockers[0].detail).toContain('db-2');
  });

  it('DB側でメールアドレスが重複していたら中断する', () => {
    const plan = planUserIdMigration({
      dbUsers: [admin, { ...member, email: 'KIMURA@example-corp.co.jp' }],
      authUsers: [
        { sub: 'supabase-admin', email: 'kimura@example-corp.co.jp' },
      ],
    });
    expect(plan.blockers.map((b) => b.kind)).toContain('db-duplicate-email');
  });

  it('認証側でメールアドレスが重複していたら中断する', () => {
    const plan = planUserIdMigration({
      dbUsers: [admin],
      authUsers: [
        { sub: 'supabase-a', email: 'kimura@example-corp.co.jp' },
        { sub: 'supabase-b', email: 'Kimura@example-corp.co.jp' },
      ],
    });
    expect(plan.blockers.map((b) => b.kind)).toContain('auth-duplicate-email');
  });

  it('メールアドレスが空のDB行は中断の理由にする(手がかりが無いので勝手に決めない)', () => {
    const plan = planUserIdMigration({
      dbUsers: [{ ...admin, email: null }],
      authUsers: [],
    });
    expect(plan.blockers.map((b) => b.kind)).toEqual(['db-email-missing']);
    // 消さないし、作る対象にもしない
    expect(plan.createMissing).toEqual([]);
  });
});

describe('planReverse', () => {
  const saved = {
    entries: [
      {
        email: 'kimura@example-corp.co.jp',
        from: 'cognito-admin',
        to: 'supabase-admin',
      },
      {
        email: 'sato@example-corp.co.jp',
        from: 'cognito-member',
        to: 'supabase-member',
      },
    ],
  };

  it('いま新しいIDになっている行だけを元に戻す', () => {
    const plan = planReverse(saved, [
      { ...admin, cognitoSub: 'supabase-admin' },
      { ...member, cognitoSub: 'supabase-member' },
    ]);
    expect(plan.updates).toEqual([
      {
        email: 'kimura@example-corp.co.jp',
        from: 'supabase-admin',
        to: 'cognito-admin',
      },
      {
        email: 'sato@example-corp.co.jp',
        from: 'supabase-member',
        to: 'cognito-member',
      },
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('控えを取った後に人が触った行は巻き戻さない', () => {
    // その行はもう別の意図で書き換わっている。こちらの都合で戻すと
    // その作業を消してしまう
    const plan = planReverse(saved, [
      { ...admin, cognitoSub: 'someone-changed-this' },
      { ...member, cognitoSub: 'supabase-member' },
    ]);
    expect(plan.updates.map((u) => u.email)).toEqual([
      'sato@example-corp.co.jp',
    ]);
    expect(plan.skipped.map((s) => s.email)).toEqual([
      'kimura@example-corp.co.jp',
    ]);
  });

  it('二度戻しても壊れない(戻し済みなら何もしない)', () => {
    const plan = planReverse(saved, [admin, member]);
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toHaveLength(2);
  });

  it('戻し先の識別子を別の行が使っていたら中断する', () => {
    const plan = planReverse(saved, [
      { ...admin, cognitoSub: 'supabase-admin' },
      { ...member, cognitoSub: 'cognito-admin' },
    ]);
    expect(plan.blockers.map((b) => b.kind)).toEqual(['sub-owned-by-other']);
    expect(plan.updates).toEqual([]);
  });
});

describe('planUserIdMigration の createMissing', () => {
  it('大文字小文字だけ違う同じメールが2行あっても、作る宛先は1件にまとめる', () => {
    // まとめないと --create-missing --apply で1人目を実際に作ってしまい
    // (仮パスワードも標準出力に出る)、2人目でemail_existsになる。
    // 認証側に残ったアカウントは自動では消えないので後始末が要る
    const plan = planUserIdMigration({
      dbUsers: [
        { id: 'db-1', email: 'A@example.com', cognitoSub: 'cognito-1' },
        { id: 'db-2', email: 'a@example.com', cognitoSub: 'cognito-2' },
      ],
      authUsers: [],
    });
    expect(plan.createMissing).toEqual([
      { email: 'a@example.com', currentSub: 'cognito-1' },
    ]);
    // 同時にblockerも立つ。作る前にこれを見て止まるのはスクリプト側の責任
    expect(plan.blockers.map((b) => b.kind)).toEqual(['db-duplicate-email']);
  });
});

/**
 * --apply の安全弁。
 *
 * AUTH_PROVIDER は「誰が発行したトークンを検証するか」の切り替えでしかなく、
 * Prismaの接続先とは何の関係もない。AUTH_PROVIDER=supabase のまま
 * AWS本番の DATABASE_URL に向けて --apply すると、全員の識別子が
 * Supabaseの値に書き換わってAWS側で誰もログインできなくなる。
 * 「いま実際に書き込む先」を見ていることをここで固定する。
 */
describe('checkWriteTarget', () => {
  const supabase =
    'postgresql://postgres.abcdefgh:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres';

  it('AUTH_PROVIDER=supabase でも、DBがローカルに向いていたら通さない', () => {
    // 実演された素通りの経路そのもの
    const check = checkWriteTarget({
      AUTH_PROVIDER: 'supabase',
      DATABASE_URL: 'postgresql://manual:pw@127.0.0.1:54321/manual_search',
      SUPABASE_DB_URL: supabase,
    });
    expect(check.ok).toBe(false);
    // 期待と実際の両方が出ていないと、どちらを直せばよいか分からない
    expect(check.expectedHost).toBe('aws-0-us-west-1.pooler.supabase.com');
    expect(check.actualHost).toBe('127.0.0.1');
  });

  it('AWS本番(RDS)に向いていたら通さない', () => {
    const check = checkWriteTarget({
      AUTH_PROVIDER: 'supabase',
      DATABASE_URL:
        'postgresql://manual:pw@manual-search.abcdefgh.ap-northeast-1.rds.amazonaws.com:5432/manual_search',
      SUPABASE_DB_URL: supabase,
    });
    expect(check.ok).toBe(false);
    expect(check.actualHost).toContain('rds.amazonaws.com');
  });

  it('SUPABASE_DB_URL が無ければ通さない(比べる相手が無い)', () => {
    const check = checkWriteTarget({
      AUTH_PROVIDER: 'supabase',
      DATABASE_URL: supabase,
    });
    expect(check.ok).toBe(false);
    expect(check.expectedHost).toBe('(未設定)');
  });

  it('DATABASE_URL が無ければ通さない(どこへ書くのか分からない)', () => {
    const check = checkWriteTarget({ SUPABASE_DB_URL: supabase });
    expect(check.ok).toBe(false);
    expect(check.actualHost).toBe('(未設定)');
  });

  it('形の読めない接続文字列は「未設定」と区別して通さない', () => {
    // パスワードに未エンコードの記号が入っているとここに来る
    const check = checkWriteTarget({
      DATABASE_URL: 'postgres@@@not a url',
      SUPABASE_DB_URL: supabase,
    });
    expect(check.ok).toBe(false);
    expect(check.actualHost).toBe('(接続文字列の形が読めません)');
  });

  it('同じホストなら、利用者名やポートやDB名が違っても通す', () => {
    // 復元手順ではpoolerのポートやDB名を変えることがある。
    // 守りたいのは「どのサーバーに書くか」なのでホスト名だけを見る
    const check = checkWriteTarget({
      DATABASE_URL:
        'postgresql://postgres:other@AWS-0-US-WEST-1.pooler.supabase.com:6543/postgres?sslmode=require',
      SUPABASE_DB_URL: supabase,
    });
    expect(check.ok).toBe(true);
    expect(check.actualHost).toBe('aws-0-us-west-1.pooler.supabase.com');
  });
});

/**
 * 錠前の配線。
 *
 * checkWriteTarget は純粋関数として固定されていたのに、それを --apply の前で
 * 実際に呼んでいる側にはテストが無かった。main() から錠前のブロックを丸ごと
 * 消しても254件すべて緑のままで、当日そのまま AWS本番のDBを書き換えられた。
 * 判定を decideAbort に出したので、ここで「止まる/通る」を直接固定する。
 */
describe('decideAbort', () => {
  const supabase =
    'postgresql://postgres.abcdefgh:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres';
  const local = 'postgresql://manual:pw@127.0.0.1:54321/manual_search';

  it('AUTH_PROVIDER=supabase でも DATABASE_URL がローカルなら --apply を中止する', () => {
    // 実演された素通りの経路。AUTH_PROVIDER だけ見ていた頃はここを通り抜けた
    const abort = decideAbort(
      {
        AUTH_PROVIDER: 'supabase',
        DATABASE_URL: local,
        SUPABASE_DB_URL: supabase,
      },
      { apply: true },
    );
    expect(abort?.code).toBe('write-target-mismatch');
    expect(abort?.message).toContain('127.0.0.1');
    expect(abort?.message).toContain('aws-0-us-west-1.pooler.supabase.com');
  });

  it('ホストが一致していれば --apply を通す', () => {
    expect(
      decideAbort(
        {
          AUTH_PROVIDER: 'supabase',
          DATABASE_URL: supabase,
          SUPABASE_DB_URL: supabase,
        },
        { apply: true },
      ),
    ).toBeNull();
  });

  it('DATABASE_URL が無ければ、下見でも中止する', () => {
    // 下見でも接続はする。未設定のまま進めるとPrismaが英語で落ちるだけ
    const abort = decideAbort({ SUPABASE_DB_URL: supabase }, { apply: false });
    expect(abort?.code).toBe('database-url-missing');
    expect(abort?.message).toContain('export DATABASE_URL="$SUPABASE_DB_URL"');
  });

  it('--apply は AUTH_PROVIDER=supabase のときだけ受け付ける', () => {
    const abort = decideAbort(
      { DATABASE_URL: supabase, SUPABASE_DB_URL: supabase },
      { apply: true },
    );
    expect(abort?.code).toBe('auth-provider-not-supabase');
  });

  it('下見(--applyなし)は、AUTH_PROVIDERが未設定でも通す', () => {
    // 切り替え前にAWS本番へ向けて突合表だけ見る、という使い方を止めない
    expect(
      decideAbort({ DATABASE_URL: supabase }, { apply: false }),
    ).toBeNull();
  });

  it('ホストが食い違ったときだけ「AWS本番のDBに向けたまま」と言う', () => {
    const abort = decideAbort(
      {
        AUTH_PROVIDER: 'supabase',
        DATABASE_URL:
          'postgresql://manual:pw@manual-search.abcdefgh.ap-northeast-1.rds.amazonaws.com:5432/manual_search',
        SUPABASE_DB_URL: supabase,
      },
      { apply: true },
    );
    expect(abort?.message).toContain(
      'AWS本番のDBに向けたまま実行すると、全員がログイン不能相当になります。',
    );
  });

  it('SUPABASE_DB_URL が無いときは、確かめていないことを断定しない', () => {
    // 実機で再現した文面の誤り: DATABASE_URL はSupabaseを向いているのに
    // 「AWS本番のDBに向けたまま」と言い切っていた。比べる相手が無いだけで、
    // 向き先が間違っているとは分かっていない
    const abort = decideAbort(
      { AUTH_PROVIDER: 'supabase', DATABASE_URL: supabase },
      { apply: true },
    );
    expect(abort?.code).toBe('write-target-unverifiable');
    expect(abort?.message).not.toContain('AWS本番のDBに向けたまま');
    expect(abort?.message).toContain('確かめられません');
    // その場で打てる指示になっていること
    expect(abort?.message).toContain('set -a; . ./.env.migration; set +a');
    expect(abort?.message).toContain('export DATABASE_URL="$SUPABASE_DB_URL"');
  });

  it('DATABASE_URL の形が読めないときも断定しない', () => {
    // パスワードに未エンコードの記号が入っているとここに来る
    const abort = decideAbort(
      {
        AUTH_PROVIDER: 'supabase',
        DATABASE_URL: 'postgres@@@not a url',
        SUPABASE_DB_URL: supabase,
      },
      { apply: true },
    );
    expect(abort?.code).toBe('write-target-unverifiable');
    expect(abort?.message).not.toContain('AWS本番のDBに向けたまま');
    expect(abort?.message).toContain('(接続文字列の形が読めません)');
  });
});
