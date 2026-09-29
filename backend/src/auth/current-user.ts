import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

export interface AuthUser {
  userId: string; // Cognitoのsub(ユーザーの不変ID)
  email?: string;
}

// Resolverの引数で「今ログインしているユーザー」を受け取るためのデコレータ
// 例: myQuery(@CurrentUser() user: AuthUser) { ... }
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    // チャットのストリーミングだけは通常のHTTPで受けるので、両方に対応する
    if (context.getType<'graphql'>() === 'graphql') {
      const ctx = GqlExecutionContext.create(context);
      return ctx.getContext<{ req: { user: AuthUser } }>().req.user;
    }
    return context.switchToHttp().getRequest<{ user: AuthUser }>().user;
  },
);
