import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  UsernameExistsException,
  UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

/** Cognitoから取り出す、管理画面に必要な最小限のユーザー情報 */
export interface CognitoUserInfo {
  sub: string;
  email: string | null;
  /** 招待直後で仮パスワードのままかどうか(画面で「招待中」と出す) */
  passwordPending: boolean;
  createdAt: Date | null;
}

/**
 * Cognitoユーザープールの管理操作(一覧・招待・削除)。
 * 認証そのもの(JWT検証)はauthモジュールの担当で、こちらは管理者向けの
 * アカウント操作だけを受け持つ。ECSタスクロールにcognito-idpの権限が必要
 */
@Injectable()
export class CognitoAdminService {
  private readonly client = new CognitoIdentityProviderClient({
    region: process.env.COGNITO_REGION,
  });
  private readonly userPoolId = process.env.COGNITO_USER_POOL_ID ?? '';

  private toInfo(user: UserType): CognitoUserInfo {
    const attr = (name: string) =>
      user.Attributes?.find((a) => a.Name === name)?.Value;
    return {
      sub: attr('sub') ?? '',
      email: attr('email') ?? null,
      passwordPending: user.UserStatus === 'FORCE_CHANGE_PASSWORD',
      createdAt: user.UserCreateDate ?? null,
    };
  }

  /** プール内の全ユーザー。社内規模(数十人)前提で全ページをなめる */
  async listUsers(): Promise<CognitoUserInfo[]> {
    const users: CognitoUserInfo[] = [];
    let paginationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListUsersCommand({
          UserPoolId: this.userPoolId,
          PaginationToken: paginationToken,
        }),
      );
      users.push(...(res.Users ?? []).map((u) => this.toInfo(u)));
      paginationToken = res.PaginationToken;
    } while (paginationToken);
    return users;
  }

  /**
   * ユーザーを招待する。Cognitoが仮パスワード付きの招待メールを送り、
   * 初回ログイン時に本人がパスワードを設定する
   */
  async createUser(email: string): Promise<CognitoUserInfo> {
    try {
      const res = await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            // 招待メールが届いた時点で実在確認できているとみなす
            { Name: 'email_verified', Value: 'true' },
          ],
          DesiredDeliveryMediums: ['EMAIL'],
        }),
      );
      if (!res.User) throw new Error('Cognitoがユーザーを返しませんでした');
      return this.toInfo(res.User);
    } catch (e) {
      if (e instanceof UsernameExistsException) {
        throw new ConflictException('このメールアドレスは既に登録されています');
      }
      throw e;
    }
  }

  /** subからユーザーを特定して削除する(ユーザー名は変わりうるのでsubで扱う) */
  async deleteUser(sub: string): Promise<void> {
    const res = await this.client.send(
      new ListUsersCommand({
        UserPoolId: this.userPoolId,
        Filter: `sub = "${sub}"`,
        Limit: 1,
      }),
    );
    const username = res.Users?.[0]?.Username;
    if (!username) {
      throw new NotFoundException('ユーザーが見つかりません');
    }
    await this.client.send(
      new AdminDeleteUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      }),
    );
  }
}
