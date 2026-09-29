import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { UserService } from '../user/service';
import type { AuthUser } from './current-user';
import { ROLES_KEY, UserRole } from './roles';

// JWT検証(GqlAuthGuard)の後に動く2つ目の門番。
// ロールはJWTでなくDBから読む(DBを直せば即時に権限を変えられる)
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly userService: UserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    // @Rolesが付いていない操作は素通し(ログイン済みなら誰でもOK)
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const req =
      context.getType<'graphql'>() === 'graphql'
        ? GqlExecutionContext.create(context).getContext<{
            req: { user?: AuthUser };
          }>().req
        : context.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!req.user) return false;

    const user = await this.userService.ensure(req.user);
    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('この操作には管理者権限が必要です');
    }
    return true;
  }
}
