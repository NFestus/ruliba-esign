import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { loadConfig } from './config';

/** Shared by main.ts and the end-to-end tests, so tests run the same security set-up as production. */
export function configureApp(app: INestApplication) {
  const cfg = loadConfig();
  const express = app as NestExpressApplication;
  express.set('trust proxy', cfg.TRUST_PROXY);
  express.disable('x-powered-by');
  app.use(
    helmet({
      // The API returns JSON only; the web app's own CSP is set by Caddy.
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      frameguard: { action: 'deny' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      hsts: cfg.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use(cookieParser());
  express.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix('api');
  // Web app and API share one origin behind Caddy, so no CORS is enabled.
  app.enableShutdownHooks();
  return app;
}
