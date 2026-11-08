import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function metaFrom(req: Request): RequestMeta {
  // req.ip honours the 'trust proxy' setting, so it is the client address seen by Caddy,
  // not a value the client can forge with its own X-Forwarded-For header.
  return {
    ip: req.ip ?? null,
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 400) || null,
  };
}

/** Controller parameter: @Meta() meta: RequestMeta */
export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  return metaFrom(ctx.switchToHttp().getRequest<Request>());
});
