import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AppConfig, CONFIG } from '../config';
import { redisConnection } from '../email/email.service';

export const SMS_QUEUE = 'sms';

export interface SmsJob {
  to: string; // E.164, e.g. +250788123456
  text: string;
}

/**
 * Text messages are queued and sent by the worker (the API container has no internet route).
 * A sign-in code is useless after 10 minutes, so retries are few and quick, and the job is
 * removed from Redis as soon as it is sent.
 */
@Injectable()
export class SmsService implements OnModuleDestroy {
  private readonly queue: Queue<SmsJob>;
  /** In tests, every queued message is also kept here so tests can read codes. */
  readonly testOutbox: SmsJob[] = [];

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.queue = new Queue<SmsJob>(SMS_QUEUE, { connection: redisConnection(config.REDIS_URL) });
  }

  async send(job: SmsJob) {
    if (this.config.NODE_ENV === 'test') this.testOutbox.push(job);
    await this.queue.add('send', job, {
      attempts: 3,
      backoff: { type: 'fixed', delay: 15_000 },
      removeOnComplete: true,
      removeOnFail: { age: 3_600 },
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}

/** "+250788123456" -> "•••• 3456", shown so people know which phone to look at. */
export function phoneHint(phone: string | null | undefined) {
  return phone ? `•••• ${phone.slice(-4)}` : '';
}
