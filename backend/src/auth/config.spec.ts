import { resolveAuthConfig } from './config';

/**
 * JWTの検証条件の組み立て。
 *
 * ここを間違えると、症状は必ず「全員が401」になる。しかも画面には
 * 「マニュアル0件・自分は管理者ではない」と出るので、利用者からは
 * データが消えたように見える(過去に同じ見え方で問い合わせが来ている)。
 *
 * 一番大事なのは1本目の「AUTH_*を1つも設定しなければ今のCognitoのまま」。
 * 切り替え日まではAWS版が本番なので、この錠前が外れたら本番が落ちる。
 */

/** 本番のCognitoと同じ形の値(値そのものは伏せて形だけ合わせてある) */
const COGNITO_ENV = {
  COGNITO_REGION: 'ap-northeast-1',
  COGNITO_USER_POOL_ID: 'ap-northeast-1_FNDNz0jSk',
  COGNITO_CLIENT_ID: '7lnm9n6l4rmnexampleclientid',
} satisfies NodeJS.ProcessEnv;

/** 実機で確認したSupabaseの値 */
const SUPABASE_URL = 'https://xscltxkkphwguetlcbkk.supabase.co';
const SUPABASE_ISSUER = `${SUPABASE_URL}/auth/v1`;

describe('resolveAuthConfig(既定=Cognito)', () => {
  it('AUTH_*を1つも設定しなければ、いまのCognitoの設定と完全に同じになる', () => {
    expect(resolveAuthConfig({ ...COGNITO_ENV })).toEqual({
      issuer:
        'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_FNDNz0jSk',
      audience: '7lnm9n6l4rmnexampleclientid',
      jwksUri:
        'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_FNDNz0jSk/.well-known/jwks.json',
      algorithms: ['RS256'],
    });
  });

  it('COGNITO_REGIONが無いときの既定はap-northeast-1(いまの挙動のまま)', () => {
    const config = resolveAuthConfig({
      COGNITO_USER_POOL_ID: 'ap-northeast-1_FNDNz0jSk',
    });
    expect(config.issuer).toBe(
      'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_FNDNz0jSk',
    );
  });

  it('AUTH_PROVIDERを書いていないなら、他のAUTH_*があってもCognitoのまま', () => {
    // 「AUTH_AUDIENCEだけ先に入れておいた」ような中途半端な状態で
    // 本番の検証条件が変わってしまうと事故になる
    const config = resolveAuthConfig({
      ...COGNITO_ENV,
      AUTH_AUDIENCE: 'authenticated',
      AUTH_ALGORITHMS: 'ES256',
    });
    expect(config.audience).toBe('7lnm9n6l4rmnexampleclientid');
    expect(config.algorithms).toEqual(['RS256']);
  });
});

describe('resolveAuthConfig(発行元を切り替えたとき)', () => {
  it('AUTH_ISSUERを設定すると、JWKSのURLはそこから組み立てる', () => {
    const config = resolveAuthConfig({
      ...COGNITO_ENV,
      AUTH_ISSUER: SUPABASE_ISSUER,
    });
    expect(config.issuer).toBe(SUPABASE_ISSUER);
    // 実機で200が返ることを確認したURL
    expect(config.jwksUri).toBe(`${SUPABASE_ISSUER}/.well-known/jwks.json`);
  });

  it('AUTH_JWKS_URIを書けばそちらが優先される', () => {
    const config = resolveAuthConfig({
      AUTH_ISSUER: SUPABASE_ISSUER,
      AUTH_JWKS_URI: 'https://example.com/keys',
    });
    expect(config.jwksUri).toBe('https://example.com/keys');
  });

  it('AUTH_ISSUERの末尾のスラッシュでJWKSのURLが二重スラッシュにならない', () => {
    const config = resolveAuthConfig({ AUTH_ISSUER: `${SUPABASE_ISSUER}/` });
    expect(config.jwksUri).toBe(`${SUPABASE_ISSUER}/.well-known/jwks.json`);
  });

  it('audienceはCOGNITO_CLIENT_IDへ落とさない(落とすと全員が401になる)', () => {
    // 実測: audienceをCognitoのclient_idのままにすると、Supabaseの
    // 本物のトークンが `jwt audience invalid` で弾かれた
    const config = resolveAuthConfig({
      ...COGNITO_ENV,
      AUTH_ISSUER: SUPABASE_ISSUER,
    });
    expect(config.audience).toBeUndefined();
  });

  it('AUTH_AUDIENCEを書けばそれで検証する', () => {
    const config = resolveAuthConfig({
      AUTH_ISSUER: SUPABASE_ISSUER,
      AUTH_AUDIENCE: 'authenticated', // Supabaseのaudは全員この固定値
    });
    expect(config.audience).toBe('authenticated');
  });

  it('署名方式の既定はRS256とES256の併記(当日の設定漏れで全員が締め出されないように)', () => {
    const config = resolveAuthConfig({ AUTH_ISSUER: SUPABASE_ISSUER });
    expect(config.algorithms).toEqual(['RS256', 'ES256']);
  });

  it('AUTH_ALGORITHMSはカンマ区切りで読み、空白と小文字を許す', () => {
    const config = resolveAuthConfig({
      AUTH_ISSUER: SUPABASE_ISSUER,
      AUTH_ALGORITHMS: ' es256 , rs256 ',
    });
    expect(config.algorithms).toEqual(['ES256', 'RS256']);
  });

  it('JWKSで配れない方式(HS256)やnoneは書かれても捨てる', () => {
    const config = resolveAuthConfig({
      AUTH_ISSUER: SUPABASE_ISSUER,
      AUTH_ALGORITHMS: 'ES256,HS256,none',
    });
    expect(config.algorithms).toEqual(['ES256']);
  });

  it('綴り間違いで全部が捨てられたら既定に戻す(空の許可リストで締め出さない)', () => {
    const config = resolveAuthConfig({
      AUTH_ISSUER: SUPABASE_ISSUER,
      AUTH_ALGORITHMS: 'ES-256',
    });
    expect(config.algorithms).toEqual(['RS256', 'ES256']);
  });
});

describe('resolveAuthConfig(AUTH_PROVIDER=supabase)', () => {
  it('SUPABASE_URLからissuerを組み立てる(AUTH_ISSUERの設定し忘れを1つ減らす)', () => {
    const config = resolveAuthConfig({
      ...COGNITO_ENV,
      AUTH_PROVIDER: 'supabase',
      SUPABASE_URL,
    });
    // 実機で発行したトークンのissと同じ文字列
    expect(config.issuer).toBe(SUPABASE_ISSUER);
    expect(config.jwksUri).toBe(`${SUPABASE_ISSUER}/.well-known/jwks.json`);
    expect(config.audience).toBeUndefined();
    expect(config.algorithms).toEqual(['RS256', 'ES256']);
  });

  it('SUPABASE_URLの末尾にスラッシュがあっても同じissuerになる', () => {
    const config = resolveAuthConfig({
      AUTH_PROVIDER: 'supabase',
      SUPABASE_URL: `${SUPABASE_URL}/`,
    });
    expect(config.issuer).toBe(SUPABASE_ISSUER);
  });

  it('AUTH_ISSUERを明示していればそちらが勝つ', () => {
    const config = resolveAuthConfig({
      AUTH_PROVIDER: 'supabase',
      SUPABASE_URL,
      AUTH_ISSUER: 'https://auth.example.com/',
    });
    expect(config.issuer).toBe('https://auth.example.com/');
  });

  it('SUPABASE_URLもAUTH_ISSUERも無ければ起動時に落とす(黙ってCognitoに戻さない)', () => {
    expect(() =>
      resolveAuthConfig({ ...COGNITO_ENV, AUTH_PROVIDER: 'supabase' }),
    ).toThrow(/SUPABASE_URL/);
  });
});
