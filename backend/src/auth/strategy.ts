import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { passportJwtSecret } from 'jwks-rsa';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { resolveAuthConfig } from './config';

// リクエストに付いてくるJWTを検証する戦略。
// 発行元・宛先・署名方式は環境変数で決まる(config.ts参照。何も設定しなければ
// 今までどおりCognito)。署名の検証鍵は発行元が公開しているJWKSエンドポイントから
// 自動取得する(キャッシュ付き)
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    const auth = resolveAuthConfig(process.env);

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      algorithms: auth.algorithms,
      issuer: auth.issuer, // 「うちが使っている認証基盤が発行したか」を検証
      audience: auth.audience, // 「うちのアプリ向けか」を検証(未設定なら見ない)
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: auth.jwksUri,
      }),
    });
  }

  // 署名・発行元・期限の検証が通った後に呼ばれる。
  // 返した値が req.user としてResolverから参照できる。
  // subとemailはCognitoのIDトークンにもSupabaseのアクセストークンにも
  // トップレベルにあるので、ここは両者で共通のまま
  validate(payload: { sub: string; email?: string }) {
    return { userId: payload.sub, email: payload.email };
  }
}
