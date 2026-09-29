import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../generated/prisma/client';

export const ROLES_KEY = 'roles';

// @Roles(UserRole.ADMIN) を付けたQuery/Mutationは、そのロールを持つ人だけ実行できる
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export { UserRole };
