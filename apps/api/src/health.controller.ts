import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { Public } from './auth/decorators';
import { sql } from 'drizzle-orm';
import { DbService } from './db/db';
import { AppConfig, CONFIG } from './config';
import { redisConnection } from './email/email.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly dbs: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Used by Docker and monitoring. Says only up/down, nothing about versions or internals. */
  @Public()
  @Get()
  async health() {
    const checks = { database: false, queue: false };
    try {
      await this.dbs.db.execute(sql`SELECT 1`);
      checks.database = true;
    } catch {
      /* reported below */
    }
    const redis = new Redis({ ...redisConnection(this.config.REDIS_URL), lazyConnect: true, connectTimeout: 2000 });
    try {
      await redis.connect();
      checks.queue = (await redis.ping()) === 'PONG';
    } catch {
      /* reported below */
    } finally {
      redis.disconnect();
    }
    if (!checks.database || !checks.queue) throw new ServiceUnavailableException({ status: 'down', checks });
    return { status: 'up', checks };
  }
}
