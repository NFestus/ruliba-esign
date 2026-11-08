import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@ruliba/shared';

export const IS_PUBLIC = 'isPublic';
export const ROLES_KEY = 'roles';
export const ALLOW_PENDING_PASSWORD = 'allowPendingPassword';

/** No sign-in needed (login, refresh, health, later: signing links and verification page). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Signed-in user must hold at least one of these roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Reachable even while the user still has to replace a temporary password. */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  departmentId: string | null;
  sessionFamily: string;
  mustChangePassword: boolean;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
