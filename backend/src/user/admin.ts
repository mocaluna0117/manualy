/**
 * 利用者アカウントの管理操作(一覧・追加・削除)の共通の口。
 *
 * 中身はCognito(AWS版)とSupabase Auth(移行後)の2つあり、
 * AUTH_PROVIDERで選ぶ(module.ts)。UserServiceはこの口だけを見るので、
 * 切り替えでUserService側の処理は変わらない。
 */

/**
 * 管理画面に必要な最小限の利用者情報。
 *
 * cognito.ts の CognitoUserInfo と同じ形に temporaryPassword を足しただけ。
 * 省略可にしてあるので CognitoUserInfo をそのまま代入でき、Cognito版の
 * コードは1文字も触らずに済む(AWS版を壊さないための措置)
 */
export interface AdminUserInfo {
  sub: string;
  email: string | null;
  /** まだ一度もログインしていない(画面で「招待中」と出す) */
  passwordPending: boolean;
  createdAt: Date | null;
  /**
   * 発行した仮パスワード。作成したその場でしか分からないので、
   * ここに載せて呼び出し元(管理画面)まで運ぶ。
   * Supabase版だけが入れる。一覧や削除では常に無い
   */
  temporaryPassword?: string | null;
}

export interface UserAdminService {
  /** 全利用者。社内規模(数十人)前提で全ページをなめる */
  listUsers(): Promise<AdminUserInfo[]>;
  /**
   * 利用者を追加する。
   * 既に同じメールアドレスが居れば ConflictException を投げる
   */
  createUser(email: string): Promise<AdminUserInfo>;
  /** 居なければ NotFoundException を投げる */
  deleteUser(sub: string): Promise<void>;
}

/**
 * DIトークン。インターフェースは実行時に消えるのでクラスを指定できず、
 * 文字列トークンで注入する
 */
export const USER_ADMIN = 'USER_ADMIN';
