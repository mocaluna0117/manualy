/**
 * 認証基盤を替えたときに、DBの利用者行を新しい識別子へ付け替える計画を立てる。
 *
 * なぜ必要か: JITプロビジョニング(service.ts の ensure())は
 * `User.cognito_sub` で行を探す。CognitoのsubとSupabaseのUUIDは当然ちがう値
 * なので、付け替えないまま切り替えると、同じ人が「初めて来た人」として
 * 新しい行で作られる。すると管理者はMEMBERに落ち、会話履歴は前の行に
 * ぶら下がったままなので、本人からは消えたように見える。
 *
 * 判定だけをここに純粋関数として置き、DBへの書き込みと画面表示は
 * scripts/migrate-user-ids.ts が受け持つ(テストできるようにするため)。
 */

/** DBのUser行のうち、突き合わせに使う項目 */
export interface DbUserRow {
  id: string;
  email: string | null;
  cognitoSub: string;
  role?: string;
}

/** 認証側(Supabase Auth)の利用者 */
export interface AuthUserRow {
  sub: string;
  email: string | null;
}

/** 1行ぶんの付け替え */
export interface SubChange {
  /** 突き合わせに使った小文字のメールアドレス */
  email: string;
  from: string;
  to: string;
}

/**
 * 中断すべき状態。1件でもあれば書き込みはしない。
 * 途中まで書いて止まると、誰が新IDで誰が旧IDか分からなくなるため
 */
export interface MigrationBlocker {
  kind:
    | 'db-email-missing'
    | 'db-duplicate-email'
    | 'auth-duplicate-email'
    | 'sub-owned-by-other';
  detail: string;
}

export interface UserIdMigrationPlan {
  /** 付け替える行 */
  updates: SubChange[];
  /** すでに新しいIDになっている行(再実行しても二度書きしない) */
  alreadyDone: { email: string; sub: string }[];
  /** DBには居るが認証側に居ない人(--create-missingで作る対象) */
  createMissing: { email: string; currentSub: string }[];
  /** 認証側には居るがDBに行が無い人(消さずに報告するだけ) */
  unmatchedAuth: { email: string; sub: string }[];
  blockers: MigrationBlocker[];
}

/**
 * 突き合わせ用にメールアドレスを揃える。
 *
 * 小文字化と前後の空白落としだけで、ドットや+aliasの正規化はしない。
 * Supabase側も小文字で保存されることは実機で確認済み。賢くやると
 * 「別人を同一人物とみなす」方向に外れうるので、取りこぼしは
 * 突き合わせ不能として人に見せる方に倒す
 */
export const normalizeEmail = (email: string | null | undefined): string =>
  (email ?? '').trim().toLowerCase();

/** 同じメールアドレスで複数の行がある場合を探す */
function findDuplicates<T>(
  rows: T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return new Map([...groups].filter(([, list]) => list.length > 1));
}

export function planUserIdMigration(input: {
  dbUsers: DbUserRow[];
  authUsers: AuthUserRow[];
}): UserIdMigrationPlan {
  const { dbUsers, authUsers } = input;
  const blockers: MigrationBlocker[] = [];

  // --- 突き合わせの前に、判断できない状態を洗い出す ---

  // メールアドレスが無い行。手がかりが無いので勝手に決められない。
  // DBでメールアドレスを埋めれば先へ進める(いまは該当0件)
  for (const row of dbUsers) {
    if (!normalizeEmail(row.email)) {
      blockers.push({
        kind: 'db-email-missing',
        detail: `DBの利用者 id=${row.id} (cognito_sub=${row.cognitoSub}) にメールアドレスがありません`,
      });
    }
  }

  for (const [email, rows] of findDuplicates(dbUsers, (r) =>
    normalizeEmail(r.email),
  )) {
    blockers.push({
      kind: 'db-duplicate-email',
      detail: `DBに ${email} の行が${rows.length}件あります (id=${rows.map((r) => r.id).join(', ')})`,
    });
  }

  for (const [email, rows] of findDuplicates(authUsers, (r) =>
    normalizeEmail(r.email),
  )) {
    blockers.push({
      kind: 'auth-duplicate-email',
      detail: `認証側に ${email} の利用者が${rows.length}件あります (sub=${rows.map((r) => r.sub).join(', ')})`,
    });
  }

  // 認証側のIDが、すでにDBの「別人」の行に入っている状態。
  // このまま付け替えると、その人のログインが他人の履歴に着地する。
  // UNIQUE制約(User_cognito_sub_key)にも引っかかるので必ず止める
  const dbBySub = new Map(dbUsers.map((r) => [r.cognitoSub, r]));
  for (const auth of authUsers) {
    const owner = dbBySub.get(auth.sub);
    if (!owner) continue;
    if (normalizeEmail(owner.email) !== normalizeEmail(auth.email)) {
      blockers.push({
        kind: 'sub-owned-by-other',
        detail: `認証側の ${normalizeEmail(auth.email) || '(メール無し)'} のID ${auth.sub} が、DBでは別人 ${normalizeEmail(owner.email) || '(メール無し)'} (id=${owner.id}) の行に入っています`,
      });
    }
  }

  // --- 突き合わせ ---
  const authByEmail = new Map(
    authUsers.map((a) => [normalizeEmail(a.email), a]),
  );
  const updates: SubChange[] = [];
  const alreadyDone: { email: string; sub: string }[] = [];
  const createMissing: { email: string; currentSub: string }[] = [];

  // 同じメールの行が2つあると(db-duplicate-email)、そのままでは
  // createMissingに同じ宛先が2回入る。認証側に1人目を作った直後に
  // 2人目でemail_existsになるので、ここで宛先を1件にまとめておく
  const createMissingSeen = new Set<string>();

  for (const row of dbUsers) {
    const email = normalizeEmail(row.email);
    if (!email) continue; // 上でblockerにしてある
    const auth = authByEmail.get(email);
    if (!auth) {
      // 先に見つかった行のcognito_subを載せる(どちらを載せても
      // 「認証側に居ない」という報告の意味は変わらない)
      if (!createMissingSeen.has(email)) {
        createMissingSeen.add(email);
        createMissing.push({ email, currentSub: row.cognitoSub });
      }
      continue;
    }
    if (auth.sub === row.cognitoSub) {
      // 何度実行しても安全にするための分岐(2回目以降はここに来る)
      alreadyDone.push({ email, sub: auth.sub });
      continue;
    }
    updates.push({ email, from: row.cognitoSub, to: auth.sub });
  }

  const dbEmails = new Set(dbUsers.map((r) => normalizeEmail(r.email)));
  const unmatchedAuth = authUsers
    .filter((a) => !dbEmails.has(normalizeEmail(a.email)))
    .map((a) => ({ email: normalizeEmail(a.email), sub: a.sub }));

  return { updates, alreadyDone, createMissing, unmatchedAuth, blockers };
}

/**
 * --apply の書き込み先が本当にSupabaseかを確かめた結果。
 *
 * ホスト名だけを持ち回るのは、利用者名とパスワードを含む接続文字列を
 * 画面やログに出さないため。突き合わせも大文字小文字を無視したホスト名
 * どうしで行う(ポートやDB名は復元手順で変わりうるので見ない)
 */
export type WriteTargetCheck =
  | { ok: true; actualHost: string; expectedHost: string }
  | {
      ok: false;
      /**
       * 止めた理由の種類。文面を分けるために持つ。
       * 「AWS本番に向いたままだ」と言い切ってよいのは host-mismatch の
       * ときだけで、読めない・未設定のときは何も確かめられていない
       */
      kind: 'expected-unreadable' | 'actual-unreadable' | 'host-mismatch';
      reason: string;
      actualHost: string;
      expectedHost: string;
    };

/** 接続文字列からホスト名だけを取り出す。読めなければnull */
export function databaseHost(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const host = new URL(value).hostname;
    return host ? host.toLowerCase() : null;
  } catch {
    // パスワードに未エンコードの記号が入っているとここに来る
    return null;
  }
}

/** 人に見せる用。未設定と「形が読めない」を区別する */
const describeHost = (host: string | null, raw: string | undefined): string =>
  host ?? (raw?.trim() ? '(接続文字列の形が読めません)' : '(未設定)');

/**
 * 書き換える前に「いまPrismaが繋ぐ先」がSupabaseかどうかを確かめる。
 *
 * AUTH_PROVIDER を見るだけでは足りない。あれは認証基盤(誰のトークンを
 * 検証するか)の切り替えで、Prismaの接続先とは何の関係もないので、
 * AUTH_PROVIDER=supabase のままAWS本番のDATABASE_URLに向けて --apply すると
 * 素通りしてしまう(実演済み)。だから DATABASE_URL のホストが
 * SUPABASE_DB_URL のホストと一致することを、書き込みの直前に実際に見る。
 *
 * SUPABASE_DB_URL が無いときは「一致している」と判断できないので中止する。
 * 比べる相手が無いまま通してしまうと、この錠前は何も守っていないのと同じ
 */
export function checkWriteTarget(env: NodeJS.ProcessEnv): WriteTargetCheck {
  const actual = databaseHost(env.DATABASE_URL);
  const expected = databaseHost(env.SUPABASE_DB_URL);
  const actualHost = describeHost(actual, env.DATABASE_URL);
  const expectedHost = describeHost(expected, env.SUPABASE_DB_URL);

  if (!expected) {
    return {
      ok: false,
      kind: 'expected-unreadable',
      reason:
        'SUPABASE_DB_URL が読めないので、書き込み先がSupabaseかどうかを確かめられません',
      actualHost,
      expectedHost,
    };
  }
  if (!actual) {
    return {
      ok: false,
      kind: 'actual-unreadable',
      reason: 'DATABASE_URL が読めないので、どこへ書くのか分かりません',
      actualHost,
      expectedHost,
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      kind: 'host-mismatch',
      reason:
        '書き込み先のDBが SUPABASE_DB_URL のホストと違います(AWS本番に向いたままの可能性があります)',
      actualHost,
      expectedHost,
    };
  }
  return { ok: true, actualHost, expectedHost };
}

/**
 * --apply / 下見 を始める前に、環境変数と引数だけで分かる中止理由。
 *
 * 錠前を scripts/migrate-user-ids.ts の main() に if で並べていたときは、
 * その配線を丸ごと消してもテストが1件も落ちなかった(254件すべて緑のまま)。
 * 判定と文面をここへ出して、specから「この環境なら止まる/通る」を直接固定する。
 *
 * 返すのは中止理由かnull。表示と終了コードは呼び出し側に任せる
 */
export interface AbortDecision {
  /** どの錠前で止めたか。文面ではなくこれで突き合わせる */
  code:
    | 'database-url-missing'
    | 'auth-provider-not-supabase'
    | 'write-target-unverifiable'
    | 'write-target-mismatch';
  /** そのまま人に見せる文面 */
  message: string;
}

/**
 * 書き込み先を確かめられなかったときに添える、その場で打てる指示。
 *
 * ここで「AWS本番に向いています」と言ってはいけない。確かめられなかった
 * のだから、向き先が正しいかどうかはまだ誰も知らない
 */
const RETRY_HINT =
  '      set -a; . ./.env.migration; set +a\n' +
  '      export DATABASE_URL="$SUPABASE_DB_URL"\n' +
  '      を実行してから、もう一度どうぞ。';

export function decideAbort(
  env: NodeJS.ProcessEnv,
  options: { apply: boolean },
): AbortDecision | null {
  // 下見でも接続先は要る。未設定のまま進めると PrismaService が英語で
  // 落ちるだけなので、何を渡せばよいかをここで日本語で言う
  if (!env.DATABASE_URL?.trim()) {
    return {
      code: 'database-url-missing',
      message: '中止: DATABASE_URL が設定されていません。\n' + RETRY_HINT,
    };
  }

  // 認証側(SupabaseのAdmin API)を相手にしているかの確認。
  // DBの向き先とは別の話なので、錠前も別に置く
  if (options.apply && env.AUTH_PROVIDER?.trim().toLowerCase() !== 'supabase') {
    return {
      code: 'auth-provider-not-supabase',
      message:
        '中止: --apply は AUTH_PROVIDER=supabase のときだけ受け付けます。\n' +
        '      認証側の利用者一覧をSupabaseから取るための指定です(DBの向き先は別途 DATABASE_URL で確かめます)。',
    };
  }

  // ここが本丸: 「いま実際に書き込む先」がSupabaseかを確かめる。
  // AUTH_PROVIDER はPrismaの接続先と無関係なので、それだけでは守れない
  if (options.apply) {
    const target = checkWriteTarget(env);
    if (!target.ok) {
      const head =
        `中止: ${target.reason}\n` +
        `      期待するホスト (SUPABASE_DB_URL): ${target.expectedHost}\n` +
        `      実際のホスト   (DATABASE_URL)   : ${target.actualHost}\n`;
      // 「AWS本番のDBに向けたまま」と言い切ってよいのは、両方のホストが
      // 読めて食い違ったときだけ。片方でも読めないときに同じ文を出すと、
      // 実際はSupabaseを向いているのに嘘を言うことになる(実機で再現した)
      if (target.kind === 'host-mismatch') {
        return {
          code: 'write-target-mismatch',
          message:
            head +
            '      AWS本番のDBに向けたまま実行すると、全員がログイン不能相当になります。',
        };
      }
      return {
        code: 'write-target-unverifiable',
        message:
          head +
          '      比べる相手が無いので、いまの接続先が正しいかどうかは確かめられません。\n' +
          RETRY_HINT,
      };
    }
  }

  return null;
}

/** --save で書き出す控え。--reverse でそのまま読み戻す */
export interface SavedMigration {
  savedAt: string;
  /** 実際に書き換えたのか、下見(dry-run)だけだったのか */
  applied: boolean;
  issuer?: string;
  entries: SubChange[];
}

export interface ReversePlan {
  updates: SubChange[];
  /** 現在値が控えと合わないので戻さなかった行 */
  skipped: { email: string; expected: string; actual: string }[];
  blockers: MigrationBlocker[];
}

/**
 * 切り戻しの計画。
 *
 * 控えに載っていても、いま実際に新IDになっている行だけを戻す。
 * 控えを取った後に人がその行を触っていた場合、こちらの都合で
 * 巻き戻すと、その人の作業を消してしまうため
 */
export function planReverse(
  saved: { entries: SubChange[] },
  dbUsers: DbUserRow[],
): ReversePlan {
  const dbBySub = new Map(dbUsers.map((r) => [r.cognitoSub, r]));
  const updates: SubChange[] = [];
  const skipped: { email: string; expected: string; actual: string }[] = [];
  const blockers: MigrationBlocker[] = [];

  for (const entry of saved.entries) {
    const row = dbBySub.get(entry.to);
    if (!row) {
      skipped.push({
        email: entry.email,
        expected: entry.to,
        actual: '(その識別子の行はもうありません)',
      });
      continue;
    }
    const occupied = dbBySub.get(entry.from);
    if (occupied && occupied.id !== row.id) {
      blockers.push({
        kind: 'sub-owned-by-other',
        detail: `${entry.email} を ${entry.from} に戻そうとしましたが、その識別子は別の行 (id=${occupied.id}) が使っています`,
      });
      continue;
    }
    updates.push({ email: entry.email, from: entry.to, to: entry.from });
  }

  return { updates, skipped, blockers };
}
