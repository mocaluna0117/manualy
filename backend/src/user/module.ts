import { Module } from '@nestjs/common';
import { USER_ADMIN, UserAdminService } from './admin';
import { CognitoAdminService } from './cognito';
import { UserResolver } from './resolver';
import { UserService } from './service';
import { SupabaseAdminService } from './supabase';

@Module({
  providers: [
    UserService,
    UserResolver,
    CognitoAdminService,
    SupabaseAdminService,
    {
      // 利用者管理の実体をAUTH_PROVIDERで選ぶ。
      // 既定はcognito: 切り替え日まではAWSが本番なので、書き忘れたら
      // 今までどおりになる側へ倒す。supabaseで動かしている間もCognito版は
      // providerに残るが、資格情報が無い環境で構築しても例外は出ず、
      // 呼ばなければ通信もしない(実機で確認)ので消していない
      provide: USER_ADMIN,
      useFactory: (
        cognito: CognitoAdminService,
        supabase: SupabaseAdminService,
      ): UserAdminService =>
        process.env.AUTH_PROVIDER?.trim().toLowerCase() === 'supabase'
          ? supabase
          : cognito,
      inject: [CognitoAdminService, SupabaseAdminService],
    },
  ],
  // SupabaseAdminServiceを出しているのは、利用者IDの移行スクリプトが
  // app.get()で直接使うため
  exports: [UserService, SupabaseAdminService],
})
export class UserModule {}
