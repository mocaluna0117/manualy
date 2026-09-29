/**
 * 利用者の識別子(User.cognito_sub)を、新しい認証基盤のIDへ付け替える。
 *
 * これを実行しないまま切り替えると、JITプロビジョニング(user/service.ts の
 * ensure())が同じ人を「初めて来た人」として別の行で作る。管理者はMEMBERに
 * 落ち、会話履歴は前の行にぶら下がったままなので本人からは消えたように見える。
 *
 * 打ち方は --help に全部入れてある(9/11 と 9/12 で出方が違うので両方載せた)。要点:
 *   0) 環境    set -a; . ./.env.migration; set +a
 *              export DATABASE_URL="$SUPABASE_DB_URL"   # 書き込み先。省略できない
 *              export DATABASE_SSL_CA="$PWD/backend/certs/supabase-ca.crt" # 下見でも要る
 *              export AUTH_PROVIDER=supabase
 *              SAVE=~/manual-search-backups/user-ids-$(date +%Y%m%d).json
 *   1) 下見    node dist/src/scripts/migrate-user-ids.js --create-missing
 *              → 誰を認証側に作るか・誰をどのIDへ付け替えるかを表で確認する
 *   2) 実行    node dist/src/scripts/migrate-user-ids.js --create-missing --apply --save "$SAVE"
 *              → 認証側に足りない人を作り、DBの識別子を1トランザクションで
 *                付け替え、控えを書き出す
 *                (仮パスワードが出るのは 9/11 の1回だけ。9/12 は0件。→ --help)
 *   3) 確認    管理画面にログインし、管理者のままで会話履歴が見えることを確かめる
 *   4) 切り戻し node dist/src/scripts/migrate-user-ids.js --reverse "$SAVE" --apply
 *
 * 控えの置き場所は ~/manual-search-backups/user-ids-YYYYMMDD.json に固定する
 * (/tmp でもホーム直下でもない)。切り戻しは
 * `ls -t ~/manual-search-backups/user-ids-*.json | head -1` で最新の控えを拾う作りなので、
 * よそに書くとこの glob が0件になり、空の $SAVE が --reverse に渡って止まる。
 *
 * 既定は下見(dry-run)で、--apply を付けたときだけ書き換える。
 * --apply の安全弁は「いま実際に書き込む先」を見る: DATABASE_URL のホストが
 * SUPABASE_DB_URL のホストと一致しなければ中止する(user/migrate-user-ids.ts の
 * decideAbort / checkWriteTarget)。AUTH_PROVIDER は「誰が発行したトークンを検証するか」の
 * 切り替えでしかなく、Prismaの接続先とは何の関係もない。AUTH_PROVIDER だけを
 * 見ていた頃は、AWS本番のDATABASE_URLに向けたままでも素通りできた。
 *
 * 実行: cd backend && npm run build && node dist/src/scripts/migrate-user-ids.js [オプション]
 *   (ts-node直接実行はPrisma生成クライアントの.js拡張子importを解決できない)
 *
 * AppModuleではなく最小限のモジュールを組み立てているのは、
 * (a) AppModuleを起こすとGraphQLのスキーマ(src/schema.gql)が書き換わる
 * (b) 認証と利用者管理に関係のないモジュール(チャット・マニュアル)の
 *     設定不足でスクリプトが動かなくなるのを避ける、の2つの理由から。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { resolveAuthConfig } from '../auth/config';
import { PrismaModule } from '../prisma/module';
import { PrismaService } from '../prisma/service';
import type {
  DbUserRow,
  MigrationBlocker,
  SavedMigration,
  SubChange,
} from '../user/migrate-user-ids';
import {
  checkWriteTarget,
  decideAbort,
  planReverse,
  planUserIdMigration,
} from '../user/migrate-user-ids';
import { UserModule } from '../user/module';
import { SupabaseAdminService } from '../user/supabase';

/**
 * ConfigModule.forRoot() は入れない。あれは backend/.env を読んで
 * process.env に流し込むので、DATABASE_URL を渡し忘れたときに
 * ローカル開発用の localhost:54321 が黙って書き込み先になる。
 * このスクリプトは環境変数で明示された接続先にしか繋がない
 */
@Module({
  imports: [PrismaModule, UserModule],
})
class MigrateUserIdsModule {}

interface Options {
  apply: boolean;
  createMissing: boolean;
  savePath?: string;
  reversePath?: string;
  /** 省略可。spec が組み立てる Options を壊さないため必須にしない */
  help?: boolean;
}

/** 引数解析のライブラリは入っていないので自前で読む */
function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, createMissing: false };
  const valueOf = (i: number, name: string) => {
    const value = argv[i];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} にはファイルのパスが要ります`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--apply':
        options.apply = true;
        break;
      case '--create-missing':
        options.createMissing = true;
        break;
      case '--save':
        options.savePath = valueOf((i += 1), '--save');
        break;
      case '--reverse':
        options.reversePath = valueOf((i += 1), '--reverse');
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(
          `知らない引数です: ${argv[i]} (使えるのは --apply / --create-missing / --save <path> / --reverse <path> / --help)`,
        );
    }
  }
  return options;
}

/**
 * --help の中身。当日いちばん最初に打たれる想定なので、オプション一覧だけでなく
 * 「9/11 と 9/12 で何が違うか」まで書く(手順書 docs/b-plan-implementation-handbook.md
 * 「手順5」と同じ内容。片方だけ直すと当日どちらを信じるか分からなくなる)
 */
function printUsage(): void {
  console.log(`利用者の識別子(User.cognito_sub)を Supabase Auth のIDへ付け替える。

使い方:
  node dist/src/scripts/migrate-user-ids.js [オプション]
  (cd backend && npm run build のあと。ts-node 直接実行はできない)

オプション:
  --create-missing   認証側(Supabase Auth)に居ない人を作る。--apply が無ければ作らない
  --apply            実際に書き換える。付けなければ下見(dry-run)
  --save <path>      付け替えの控えを書き出す。--apply には必須。既にあるパスなら中止する
  --reverse <path>   控えを読んで元に戻す(切り戻し)。実行するには --apply も付ける
  --help, -h         この使い方を出して終わる(何も読まない・何も書かない)

環境(9/11 も 9/12 も同じ):
  set -a; . ./.env.migration; set +a
  export DATABASE_URL="$SUPABASE_DB_URL"                        # 書き込み先。省略できない
  export DATABASE_SSL_CA="$PWD/backend/certs/supabase-ca.crt"   # 絶対パス。下見でも要る
  export AUTH_PROVIDER=supabase                                 # 認証側の一覧をSupabaseから取る
  SAVE=~/manual-search-backups/user-ids-$(date +%Y%m%d).json    # 控えの置き場所はここに固定
  cd backend && npm run build

■ 9/11(金) — 8名を認証側に作り、仮パスワードを配る
  node dist/src/scripts/migrate-user-ids.js --create-missing                     # 下見
  node dist/src/scripts/migrate-user-ids.js --create-missing --apply --save "$SAVE"

  ・下見が「DBの利用者 8人 / 認証側 0人」「認証側に作る 8件」「付け替える 0件」
    「blocker 0件」なら想定どおり
  ・★仮パスワードはこの実行の標準出力にしか出ない。再表示できないし --save のJSONにも
    入らない。実行前に画面共有を止め、控えたら Teams の個別DMで本人へ渡す

■ 9/12(土) — 復元(手順2)のあと。付け替えるだけ
  node dist/src/scripts/migrate-user-ids.js --create-missing                     # 下見
  node dist/src/scripts/migrate-user-ids.js --create-missing --apply --save "$SAVE"

  ・打つものは 9/11 と同じ($SAVE は日付が変わるので別ファイルになる)。出方だけが違う
  ・復元(scripts/restore-to-supabase.sh)が落とすのはダンプのTOCから拾った public の
    表と型だけで、auth スキーマには触らない。9/11 に作った8名はそのまま残っている。
    よって「認証側に作る人はいません」「付け替える 8件」になり、仮パスワードは1件も出ない
  ・★「認証側に作る」が0件でないときだけ手を止める。9/11 以降にAWS側で人が増えた印。
    その人ぶんの仮パスワードは出るので、その場で控えて配る

■ 切り戻し
  SAVE="$(ls -t ~/manual-search-backups/user-ids-*.json | head -1)"; echo "$SAVE"
  node dist/src/scripts/migrate-user-ids.js --reverse "$SAVE" --apply
`);
}

/** 接続先を人が見て分かる形にする。資格情報は絶対に出さない */
function describeDatabase(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return '(DATABASE_URL 未設定)';
  try {
    const url = new URL(raw);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '(DATABASE_URL の形が読めません)';
  }
}

/** 表にして出す(桁を揃えるだけ) */
function printTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  console.log(`  ${line(headers)}`);
  console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const row of rows) console.log(`  ${line(row)}`);
}

/** 中断すべき状態を並べる。1件でもあれば何も書かずに終わる */
function printBlockers(blockers: MigrationBlocker[]): void {
  console.error(`\n■ 中断 (${blockers.length}件) — 直すまで書き換えません`);
  for (const b of blockers) console.error(`  - ${b.detail}`);
}

/** 書き込みは全部かゼロか。1件ずつ更新するとUNIQUE違反で半分だけ進む */
async function applyChanges(
  prisma: PrismaService,
  updates: SubChange[],
): Promise<void> {
  await prisma.$transaction(
    updates.map((u) =>
      prisma.user.update({
        where: { cognitoSub: u.from },
        data: { cognitoSub: u.to },
      }),
    ),
  );
}

const loadDbUsers = (prisma: PrismaService): Promise<DbUserRow[]> =>
  prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, cognitoSub: true, role: true },
  });

/**
 * process.exit() を使わずに終了コードを返して抜ける。
 * exit()は書き出し途中の標準出力を切り落とすことがあり、このスクリプトは
 * 「表を読んで人が判断する」ためのものなので、途中で切れると意味がない
 *
 * export しているのは、錠前を実際に呼んでいるかをspecから確かめるため。
 * 錠前が外れると、この関数はNestを起こしにいって PrismaService が
 * 「DATABASE_URL is not set」で落ちる。つまり配線を消せばテストが落ちる
 */
export async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  // 使い方は環境も接続もいらない。何より先に出して正常終了する
  if (options.help) {
    printUsage();
    return 0;
  }

  // 実行の頭で必ず「どこに」「どの向きで」「書くのか下見か」を出す。
  // 向き先を間違えた事故は、動き出す前にここで気づくしかない
  let issuer: string;
  try {
    issuer = resolveAuthConfig(process.env).issuer;
  } catch (e) {
    issuer = `(決められません: ${e instanceof Error ? e.message : String(e)})`;
  }
  console.log('==================== 利用者IDの移行 ====================');
  console.log(`  向き        : ${options.reversePath ? '切り戻し' : '移行'}`);
  console.log(
    `  モード      : ${options.apply ? '★書き換える(--apply)' : '下見のみ(dry-run)'}`,
  );
  console.log(`  接続先のDB  : ${describeDatabase()}`);
  console.log(`  検証する発行元: ${issuer}`);
  console.log(`  認証側の接続先: ${process.env.SUPABASE_URL ?? '(未設定)'}`);
  console.log(`  AUTH_PROVIDER : ${process.env.AUTH_PROVIDER ?? '(未設定)'}`);
  console.log('========================================================');

  // --- 書き換える前に、引数と環境変数だけで分かる誤りを潰す ---

  // 錠前(DATABASE_URL未設定 / AUTH_PROVIDER / 書き込み先の突き合わせ)は
  // user/migrate-user-ids.ts の decideAbort に置いてある。ここに if を
  // 並べていたときは、その配線を消してもテストが1件も落ちなかったため
  const abort = decideAbort(process.env, options);
  if (abort) {
    console.error(abort.message);
    return 1;
  }
  // 止めなかったこと(=ホストが一致したこと)も1行出す。当日は目で見て
  // 確かめるしかないので、通った側にも証拠を残す
  const target = options.apply ? checkWriteTarget(process.env) : null;
  if (target?.ok) {
    console.log(
      `書き込み先の確認: DATABASE_URL のホスト ${target.actualHost} は SUPABASE_DB_URL と一致しています。`,
    );
  }

  if (options.apply && !options.reversePath && !options.savePath) {
    console.error(
      '中止: --apply には --save <path> を付けてください(切り戻しの控えが無いまま書き換えないため)。',
    );
    return 1;
  }
  if (options.savePath && existsSync(options.savePath)) {
    console.error(
      `中止: ${options.savePath} は既にあります。前回の控えを上書きすると切り戻せなくなるので、別の名前を指定してください。`,
    );
    return 1;
  }

  const app = await NestFactory.createApplicationContext(MigrateUserIdsModule, {
    logger: ['warn', 'error'],
  });
  try {
    return await run(
      app.get(PrismaService),
      app.get(SupabaseAdminService),
      options,
      issuer,
    );
  } finally {
    await app.close();
  }
}

/**
 * 表示と書き込みの本体。DIの後片付けはmain側に任せる。
 *
 * export しているのはテストから直接呼ぶため(偽のprisma/adminを渡して、
 * 「認証側に作る前に止まるか」を実際の分岐で確かめる)
 */
export async function run(
  prisma: PrismaService,
  admin: SupabaseAdminService,
  options: Options,
  issuer: string,
): Promise<number> {
  // ==================== 切り戻し ====================
  if (options.reversePath) {
    const saved = JSON.parse(
      readFileSync(options.reversePath, 'utf8'),
    ) as SavedMigration;
    if (!Array.isArray(saved.entries)) {
      console.error(`中止: ${options.reversePath} に entries がありません。`);
      return 1;
    }
    console.log(
      `控え: ${options.reversePath} (${saved.savedAt ?? '日時不明'} / ${saved.entries.length}件 / ${saved.applied ? '書き換え済み' : '下見'})`,
    );

    const plan = planReverse(saved, await loadDbUsers(prisma));
    console.log(`\n■ 元に戻す (${plan.updates.length}件)`);
    printTable(
      ['メール', 'いまのID', '戻す先'],
      plan.updates.map((u) => [u.email, u.from, u.to]),
    );
    if (plan.skipped.length > 0) {
      console.log(
        `\n■ 戻さない (${plan.skipped.length}件) — 控えを取った後に人が触った行は巻き戻さない`,
      );
      printTable(
        ['メール', '控えのID'],
        plan.skipped.map((s) => [s.email, s.expected]),
      );
    }
    if (plan.blockers.length > 0) {
      console.error(`\n■ 中断 (${plan.blockers.length}件)`);
      for (const b of plan.blockers) console.error(`  - ${b.detail}`);
      return 1;
    }
    if (!options.apply) {
      console.log('\n下見なので何も書いていません。実行するには --apply。');
      return 0;
    }
    // 表を読み終えたところで、もう一度「どこに書くのか」を目に入れる
    console.log(
      `\n書き込み先: ${describeDatabase()} — ここに${plan.updates.length}件書き戻します`,
    );
    await applyChanges(prisma, plan.updates);
    console.log(
      `完了: ${describeDatabase()} の${plan.updates.length}件を元に戻しました。`,
    );
    return 0;
  }

  // ==================== 移行 ====================
  const dbUsers = await loadDbUsers(prisma);
  let authUsers = (await admin.listUsers()).map((u) => ({
    sub: u.sub,
    email: u.email,
  }));
  console.log(`DBの利用者 ${dbUsers.length}人 / 認証側 ${authUsers.length}人`);

  // --- 認証側に居ない人を作る ---
  if (options.createMissing) {
    // 作りはじめる前に blockers を見る。ここを飛ばすと、たとえばDBに
    // A@example.com と a@example.com の2行がある(db-duplicate-email)状態でも
    // 1人目を実際に作ってしまい(仮パスワードも標準出力に出る)、2人目で
    // email_exists になる。作ったアカウントは自動では消えないので、
    // 「書き換えてはいけない状態」と分かった時点で認証側にも触らない
    const beforeCreate = planUserIdMigration({ dbUsers, authUsers });
    if (beforeCreate.blockers.length > 0) {
      printBlockers(beforeCreate.blockers);
      console.error(
        '\n  認証側にはまだ1件も作っていません。上を直してからやり直してください。',
      );
      return 1;
    }

    const missing = beforeCreate.createMissing;
    if (missing.length === 0) {
      console.log('\n■ 認証側に作る人はいません');
    } else if (!options.apply) {
      console.log(
        `\n■ 認証側に作る (${missing.length}件) — 下見なので作りません`,
      );
      printTable(
        ['メール'],
        missing.map((m) => [m.email]),
      );
    } else {
      console.log(`\n■ 認証側に作る (${missing.length}件)`);
      console.log(
        '  ※この出力には仮パスワードが含まれます。画面共有と貼り付け先に注意してください',
      );
      const created: string[][] = [];
      const failed: string[][] = [];
      // 直列に作る。まとめて並列に投げたときに429が返るかを確かめていないので、
      // 当日に詰まらない側へ倒す(30人でも数秒で終わる)
      for (const target of missing) {
        try {
          const user = await admin.createUser(target.email);
          created.push([
            target.email,
            user.sub,
            user.temporaryPassword ?? '(発行されませんでした)',
          ]);
        } catch (e) {
          failed.push([
            target.email,
            e instanceof Error ? e.message : String(e),
          ]);
        }
      }
      printTable(['メール', '新しいID', '仮パスワード'], created);
      if (failed.length > 0) {
        console.error(`\n■ 作れなかった (${failed.length}件)`);
        printTable(['メール', '理由'], failed);
        console.error(
          '\n中止: 作れなかった人がいるのでDBは書き換えていません。原因を直してからやり直してください\n' +
            '      (作成済みの人は次回そのまま突き合わせるだけなので、二重には作られません)。',
        );
        return 1;
      }
      authUsers = (await admin.listUsers()).map((u) => ({
        sub: u.sub,
        email: u.email,
      }));
    }
  }

  const plan = planUserIdMigration({ dbUsers, authUsers });

  console.log(`\n■ 付け替える (${plan.updates.length}件)`);
  printTable(
    ['メール', 'いまのID', '新しいID'],
    plan.updates.map((u) => [u.email, u.from, u.to]),
  );
  if (plan.alreadyDone.length > 0) {
    console.log(
      `\n■ すでに新しいID (${plan.alreadyDone.length}件) — 何もしない`,
    );
    printTable(
      ['メール', 'ID'],
      plan.alreadyDone.map((u) => [u.email, u.sub]),
    );
  }
  if (plan.createMissing.length > 0) {
    console.log(
      `\n■ 認証側に居ない (${plan.createMissing.length}件) — 消さずに残す`,
    );
    printTable(
      ['メール', 'いまのID'],
      plan.createMissing.map((u) => [u.email, u.currentSub]),
    );
  }
  if (plan.unmatchedAuth.length > 0) {
    console.log(
      `\n■ DBに行が無い認証側の利用者 (${plan.unmatchedAuth.length}件) — 報告のみ`,
    );
    printTable(
      ['メール', 'ID'],
      plan.unmatchedAuth.map((u) => [u.email, u.sub]),
    );
  }

  if (plan.blockers.length > 0) {
    printBlockers(plan.blockers);
    return 1;
  }

  // 「0件でした」とだけ出すと壊れているように見えるので、次にやることを名指しする。
  // 認証側の人数で判断しないのは、試験用の利用者が1人でも居ると
  // 「0人ではない」と見えてしまい、この案内が出なくなるため
  if (plan.createMissing.length > 0 && !options.createMissing) {
    console.log(
      `\n認証側に居ない人が${plan.createMissing.length}人います。この人たちは何度実行しても突き合いません。\n` +
        '先に --create-missing を付けて実行してください(--apply が無ければ作りません)。',
    );
  }

  if (!options.apply) {
    console.log('\n下見なので何も書いていません。実行するには --apply。');
    return 0;
  }
  if (plan.updates.length === 0) {
    console.log('\n付け替える行がありません(控えも書きません)。');
    return 0;
  }

  // 控えはトランザクションの前に書く。書いた後に落ちても控えが残るし、
  // 逆にトランザクションが失敗したときは、控えを使っても現在値が
  // 合わないので何も戻さない(planReverseが現在値で判断する)
  if (options.savePath) {
    const saved: SavedMigration = {
      savedAt: new Date().toISOString(),
      applied: true,
      issuer,
      entries: plan.updates,
    };
    writeFileSync(options.savePath, `${JSON.stringify(saved, null, 2)}\n`);
    console.log(`\n控えを書きました: ${options.savePath}`);
  }
  // 表を読み終えたところで、もう一度「どこに書くのか」を目に入れる
  console.log(
    `書き込み先: ${describeDatabase()} — ここに${plan.updates.length}件書き込みます`,
  );
  await applyChanges(prisma, plan.updates);
  console.log(
    `完了: ${describeDatabase()} の${plan.updates.length}件を付け替えました。`,
  );
  if (options.savePath) {
    console.log(
      `戻すには: node dist/src/scripts/migrate-user-ids.js --reverse ${options.savePath} --apply`,
    );
  }
  return 0;
}

// import しただけでは走らせない(spec から run() を呼べるようにするため)。
// node で直接起動したときだけ本体を動かす
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      console.error(`失敗: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
}
