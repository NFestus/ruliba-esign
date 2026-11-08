import './env';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './config';

// BigInt (audit event ids, TOTP steps) is sent to clients as a string.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

async function main() {
  const cfg = loadConfig(); // fail fast on bad configuration
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, bufferLogs: true });
  configureApp(app);
  await app.listen(cfg.PORT, '0.0.0.0');
  new Logger('Main').log(`API listening on :${cfg.PORT} (${cfg.NODE_ENV}), email via ${cfg.EMAIL_TRANSPORT}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
