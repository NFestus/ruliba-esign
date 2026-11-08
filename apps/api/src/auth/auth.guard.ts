import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@ruliba/shared';
import { AppConfig, CONFIG } from '../config';
import { ALLOW_PENDING_PASSWORD, AuthUser, IS_PUBLIC, ROLES_KEY } from './decorators';

export interface AccessClaims {
  sub: string;
  email: string;
  name: string;
  roles: Role[];
  dept: string | null;
  sid: string;
  pwc: boolean;
  typ: 'access';
}

/**
 * Global guard: every route needs a valid access token unless marked @Public().
 * Then checks @Roles(). Roles are read from the token, which lives 15 minutes;
 * role changes and disabled accounts take effect at the next refresh (refresh re-reads the DB).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Please sign in.');

    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(header.slice(7), {
        secret: this.config.JWT_ACCESS_SECRET,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }
    if (claims.typ !== 'access') throw new UnauthorizedException('Please sign in.');

    const user: AuthUser = {
      id: claims.sub,
      email: claims.email,
      name: claims.name,
      roles: claims.roles,
      departmentId: claims.dept,
      sessionFamily: claims.sid,
      mustChangePassword: claims.pwc,
    };
    req.user = user;

    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, targets)) {
      throw new ForbiddenException({ message: 'Please set a new password first.', code: 'PASSWORD_CHANGE_REQUIRED' });
    }

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (required?.length && !required.some((r) => user.roles.includes(r))) {
      throw new ForbiddenException('You do not have access to this.');
    }
    return true;
  }
}
