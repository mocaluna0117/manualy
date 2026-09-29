import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { printSchema } from 'graphql';
import { UserResolver } from './resolver';

/**
 * 管理画面に返すGraphQLの型。
 *
 * Supabase版は招待メールを送らない。仮パスワードは inviteUsers の応答の
 * temporaryPassword にしか存在せず、ここが型から落ちると切り替え当日に
 * 8名へ配るものが無くなる(画面に出す・出さないはフロント側の話だが、
 * 出そうと思ったときに型が無い、という状態にはしない)。
 *
 * src/schema.gql は起動時に生成されるファイルなので、あれを見るのではなく
 * デコレーターから組み立て直して確かめる。
 */
describe('ManagedUser のGraphQL型', () => {
  let printed: string;

  beforeAll(async () => {
    const app = await NestFactory.create(GraphQLSchemaBuilderModule, {
      logger: false,
    });
    await app.init();
    const schema = await app.get(GraphQLSchemaFactory).create([UserResolver]);
    printed = printSchema(schema);
    await app.close();
  });

  it('仮パスワードを返せる(招待メールが無いSupabase版の唯一の受け渡し口)', () => {
    const block = printed.match(/type ManagedUser \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('temporaryPassword: String');
  });

  it('passwordPending は nullable(updateUserRoleでは分からない)', () => {
    // 権限変更の応答は認証側を引かないので、この値を知らない。
    // Boolean! のままだと「分からない」を返せず、falseと嘘をつくしかない
    const block = printed.match(/type ManagedUser \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('passwordPending: Boolean\n');
    expect(block).not.toContain('passwordPending: Boolean!');
  });

  it('一覧・招待・権限変更の口はそのまま残っている(AWS版の画面を壊さない)', () => {
    expect(printed).toContain('users: [ManagedUser!]!');
    expect(printed).toContain('updateUserRole(');
    expect(printed).toMatch(/inviteUsers\([\s\S]*?\): InviteResult!/);
  });
});
