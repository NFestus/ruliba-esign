import { Logger } from '@nestjs/common';
import { AppConfig } from '../config';
import { SmsJob } from './sms.service';

/** The adapter: the rest of the app only knows this interface, never the provider. */
export interface SmsTransport {
  readonly name: string;
  send(msg: SmsJob): Promise<void>;
}

/** Development: prints the text to the worker log. Not offered for sign-in in production. */
export class ConsoleSmsTransport implements SmsTransport {
  readonly name = 'console';
  private readonly log = new Logger('SMS');
  async send(msg: SmsJob) {
    this.log.log(`[console sms] to=${msg.to}\n${msg.text}`);
  }
}

/** Africa's Talking (common in Rwanda). Username "sandbox" goes to their test environment. */
export class AfricasTalkingTransport implements SmsTransport {
  readonly name = 'africastalking';
  constructor(private readonly cfg: AppConfig) {}
  async send(msg: SmsJob) {
    const host = this.cfg.AT_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const body = new URLSearchParams({ username: this.cfg.AT_USERNAME!, to: msg.to, message: msg.text });
    if (this.cfg.AT_SENDER_ID) body.set('from', this.cfg.AT_SENDER_ID);
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: this.cfg.AT_API_KEY!, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Africa's Talking answered ${res.status}: ${text.slice(0, 300)}`);
    const recipients = (JSON.parse(text) as { SMSMessageData?: { Recipients?: { status?: string; statusCode?: number }[] } }).SMSMessageData?.Recipients ?? [];
    const ok = recipients.some((r) => r.statusCode === 100 || r.statusCode === 101 || r.statusCode === 102 || r.status === 'Success');
    if (!ok) throw new Error(`Africa's Talking did not accept the message: ${text.slice(0, 300)}`);
  }
}

export class TwilioTransport implements SmsTransport {
  readonly name = 'twilio';
  constructor(private readonly cfg: AppConfig) {}
  async send(msg: SmsJob) {
    const sid = this.cfg.TWILIO_ACCOUNT_SID!;
    const auth = Buffer.from(`${sid}:${this.cfg.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: msg.to, From: this.cfg.TWILIO_FROM!, Body: msg.text }),
    });
    if (!res.ok) throw new Error(`Twilio answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export function createSmsTransport(cfg: AppConfig): SmsTransport {
  switch (cfg.SMS_TRANSPORT) {
    case 'africastalking':
      return new AfricasTalkingTransport(cfg);
    case 'twilio':
      return new TwilioTransport(cfg);
    default:
      return new ConsoleSmsTransport();
  }
}
