import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { UserModule } from '../user/module';
import { GqlAuthGuard } from './guard';
import { RolesGuard } from './roles-guard';
import { JwtStrategy } from './strategy';

@Module({
  imports: [PassportModule, UserModule],
  providers: [
    JwtStrategy,
    // APP_GUARD: アプリ全体に門番を適用(各Resolverに書いて回らなくてよい)。
    // 登録順に実行される: まずJWT検証 → 次にロール確認
    { provide: APP_GUARD, useClass: GqlAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
