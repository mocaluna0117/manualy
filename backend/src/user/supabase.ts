import { randomInt } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AdminUserInfo, UserAdminService } from './admin';

/**
 * Supabase Authの利用者管理(一覧・追加・削除)。CognitoAdminServiceの
 * 置き換えで、AUTH_PROVIDER=supabaseのときだけ使われる。
 *
 * supabase-jsは入れず、admin APIをfetchで直接叩く。使うのは3つの
 * エンドポイントだけで、依存を1つ増やす方が移行の当日に効いてくる
 * リスク(バージョン差・型の食い違い)が大きいと判断した。
 * 呼び出しにはservice_roleキーが要る。**このキーはブラウザに出さない**
 */

/** admin APIのレスポンスのうち、こちらで使う項目だけ */
interface SupabaseUser {
  id?: string;
  email?: string | null;
  created_at?: string | null;
  last_sign_in_at?: string | null;
}

/**
 * 一覧を引くときの1ページの件数。利用者は30名ほどなので1回で終わるが、
 * 既定の50のままだと51人目から静かに落ちるので明示する
 */
const PER_PAGE = 100;

/**
 * 一覧のページ送りの上限。「per_page未満が返ったら終わり」だけを頼りに
 * すると、APIの挙動が変わったときに無限ループになる。社内規模では
 * 絶対に到達しない値を天井として置いておく
 */
const MAX_PAGES = 50;

/**
 * admin APIを待つ上限。用途ごとに分けてある。
 *
 * 入れていなかったときは undici の既定(headersTimeout=300秒)まで待ってしまい、
 * 応答を返さないスタブに対して listUsers() が **302秒** 生きていた(実測)。
 * 招待は最大30件を並行に投げる(service.ts の inviteMany)ので、そこで
 * 5分待たされると管理画面もブラウザも先に諦める。
 * 書き込み(作成・削除)は一覧より少し長めにとる
 */
const TIMEOUT_MS = {
  list: 10_000,
  write: 15_000,
} as const;

/**
 * 仮パスワードの長さと文字種。
 *
 * 強度をサーバー任せにできない: admin APIは3文字のパスワードでも
 * そのまま200で作ってしまうことを実機で確認した。だからここで作る。
 *
 * 紛らわしい文字(I/l/1、O/o/0)は入れない。管理者がTeamsのDMで配り、
 * 受け取った人が手で打ち直すことがあるため。記号もシェルや
 * メーラーで化けにくいものだけに絞ってある
 */
export const TEMPORARY_PASSWORD_LENGTH = 16;
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!#%+=?@';

/** 仮パスワードを作る。4種類を必ず1文字ずつ含める */
export function generateTemporaryPassword(): string {
  const pick = (source: string) => source[randomInt(source.length)];
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < TEMPORARY_PASSWORD_LENGTH) chars.push(pick(all));
  // 混ぜないと先頭4文字が必ず「大・小・数・記号」の順になり、
  // 生成の規則が見えてしまう(Math.randomではなくcrypto側の乱数を使う)
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** admin APIの利用者を、管理画面が使う形に直す */
export function toAdminUserInfo(user: SupabaseUser): AdminUserInfo {
  return {
    sub: user.id ?? '',
    email: user.email ?? null,
    // 「まだ一度もログインしていない」の判定。作成直後のレスポンスには
    // last_sign_in_atが無く、パスワードでログインすると入る(実機で確認)。
    // identities[].last_sign_in_atは作成時点で埋まるので見てはいけない
    passwordPending: !user.last_sign_in_at,
    createdAt: user.created_at ? new Date(user.created_at) : null,
  };
}

/** エラー応答から error_code と人が読む文言を取り出す */
function readError(body: unknown): { code: string; message: string } {
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    const text = [b.msg, b.message, b.error_description, b.error].find(
      (v): v is string => typeof v === 'string',
    );
    return {
      code: typeof b.error_code === 'string' ? b.error_code : '',
      message: text ?? JSON.stringify(body),
    };
  }
  return { code: '', message: typeof body === 'string' ? body : '' };
}

/**
 * admin APIのエラーをNestの例外に対応づける。
 *
 * 文言はCognito版と1文字も変えない。管理画面はこの文字列をそのまま
 * 「送れなかった理由」として出すので、切り替えで表示が変わらないようにする
 */
export function toAdminError(status: number, body: unknown): Error {
  const { code, message } = readError(body);
  if (code === 'email_exists') {
    return new ConflictException('このメールアドレスは既に登録されています');
  }
  if (code === 'user_not_found' || status === 404) {
    return new NotFoundException('ユーザーが見つかりません');
  }
  if (status === 429) {
    // 一斉招待でここに来ることがある。1件の失敗で全体を止めない作りなので、
    // 「待てば直る」と分かる文言にして、残りは送り切る。
    //
    // ここで自動再試行はしていない。30件を並行に投げて詰まった相手に
    // すぐ投げ直すと混雑を足すだけで、Retry-Afterに従って律儀に待つと
    // 管理画面が数十秒固まる。人が画面で結果を見て、失敗した宛先だけを
    // もう一度送る方が当日に読みやすい(inviteManyは宛先ごとに理由を返す)
    return new ServiceUnavailableException(
      `Supabaseの利用者管理が混み合っています。少し待ってからやり直してください (HTTP 429: ${message})`,
    );
  }
  return new InternalServerErrorException(
    `Supabaseの利用者管理がエラーを返しました (HTTP ${status}: ${message})`,
  );
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

@Injectable()
export class SupabaseAdminService implements UserAdminService {
  /**
   * URLと鍵は呼び出しのたびに読む。構築時に検証して投げると、
   * Cognitoで運用している間(=切り替え日まで)にSupabaseの環境変数が
   * 無いだけでアプリが起動しなくなる
   */
  private config(): { baseUrl: string; key: string } {
    const baseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!baseUrl || !key) {
      throw new InternalServerErrorException(
        'SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が設定されていないため、利用者管理を実行できません',
      );
    }
    return { baseUrl, key };
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    timeoutMs: number,
    body?: unknown,
  ): Promise<T> {
    const { baseUrl, key } = this.config();
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          // service_roleキーはapikeyとAuthorizationの両方に要る(実機で確認)
          apikey: key,
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // 期限を切らないと undici の既定(300秒)まで待つ。
        // 本文の読み取りもこのsignalで打ち切られるので、ヘッダだけ返って
        // 本文が来ない相手でもここで終わる。書き方は rag/service.ts に合わせた
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e: unknown) {
      // ここで包まないと画面に「fetch failed」とだけ出て原因が分からない。
      // タイムアウトと通信断は原因も対処も違うので、文言で見分けられるようにする
      const reason =
        e instanceof Error && e.name === 'TimeoutError'
          ? `応答がありません(${Math.round(timeoutMs / 1000)}秒でタイムアウト)`
          : `接続できませんでした: ${describe(e)}`;
      throw new ServiceUnavailableException(`Supabaseの利用者管理に${reason}`);
    }

    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // JSONでない応答(プロキシのHTMLなど)は本文のまま例外に載せる
    }
    if (!res.ok) throw toAdminError(res.status, parsed);
    return parsed as T;
  }

  async listUsers(): Promise<AdminUserInfo[]> {
    const users: AdminUserInfo[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await this.call<{ users?: unknown }>(
        'GET',
        `/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}`,
        TIMEOUT_MS.list,
      );
      // 「0人」と「読めなかった」を必ず分ける。
      // ここを res.users ?? [] にしていたときは、200で users を持たない本文
      // (プロキシのHTML、ログイン画面、形の変わったJSON)がすべて0人として
      // 成功で返っていた。管理画面には「利用者が誰も居ない」と出て、
      // エラーではないので誰も気づけない ―― この案件で実際に起きた
      // 「データが消えたように見える」状態そのものなので、例外にする
      if (!Array.isArray(res?.users)) {
        throw new InternalServerErrorException(
          `Supabaseの利用者管理が想定外の応答を返しました (${page}ページ目に利用者の配列がありません)`,
        );
      }
      const batch = res.users as SupabaseUser[];
      users.push(...batch.map(toAdminUserInfo));
      // 最後のページは必ずper_page未満になる(0件のページも含む)
      if (batch.length < PER_PAGE) break;
    }
    return users;
  }

  /**
   * 利用者を追加する。
   *
   * 招待メールは使わない。Supabaseの組み込みメールは送信数の制限が厳しく、
   * 切り替え当日に一斉招待すると途中で止まる。代わりに仮パスワードを
   * こちらで発行して呼び出し元に返し、管理者がTeamsのDMで配る運用にした。
   * email_confirm:true は、確認メールを送らずに使える状態で作るため
   */
  async createUser(email: string): Promise<AdminUserInfo> {
    const password = generateTemporaryPassword();
    const created = await this.call<SupabaseUser>(
      'POST',
      '/auth/v1/admin/users',
      TIMEOUT_MS.write,
      { email, password, email_confirm: true },
    );
    return { ...toAdminUserInfo(created), temporaryPassword: password };
  }

  /** subで削除する。居なければNotFoundException(Cognito版と揃える) */
  async deleteUser(sub: string): Promise<void> {
    await this.call<unknown>(
      'DELETE',
      `/auth/v1/admin/users/${encodeURIComponent(sub)}`,
      TIMEOUT_MS.write,
    );
  }
}
