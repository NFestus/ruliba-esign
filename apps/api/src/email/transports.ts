import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { AppConfig } from '../config';

export interface OutgoingEmail {
  to: string;
  /** Staff member the email is sent for: display name "X via Ruliba eSign", Reply-To their address. */
  onBehalfOf?: { name: string; email: string };
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

/** Display name for the From line; quotes, angle brackets and line breaks removed so a name cannot alter headers. */
export function viaName(name: string) {
  const clean = name.replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${clean} via Ruliba eSign`;
}

/** Splits "Name <address>" into its parts. */
export function parseFrom(from: string) {
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: from.trim() };
}

/** The adapter: the rest of the app only knows this interface, never the provider. */
export interface EmailTransport {
  readonly name: string;
  send(msg: OutgoingEmail): Promise<void>;
}

/** Development only: prints emails to the log. Refused in production by config validation. */
export class ConsoleTransport implements EmailTransport {
  readonly name = 'console';
  private readonly log = new Logger('Email');
  readonly sent: OutgoingEmail[] = [];
  async send(msg: OutgoingEmail) {
    this.sent.push(msg);
    const files = msg.attachments?.map((a) => `${a.filename} (${a.content.length} bytes)`).join(', ');
    const via = msg.onBehalfOf ? ` from="${viaName(msg.onBehalfOf.name)}" reply-to=${msg.onBehalfOf.email}` : '';
    this.log.log(`[console email] to=${msg.to}${via} subject="${msg.subject}"${files ? ` attachments=${files}` : ''}\n${msg.text}`);
  }
}

/** Any SMTP server — used until the ruliba.com tenant migration finishes. */
export class SmtpTransport implements EmailTransport {
  readonly name = 'smtp';
  private readonly transporter;
  constructor(private readonly cfg: AppConfig) {
    this.transporter = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_PORT === 465,
      // STARTTLS on 587: never send credentials in clear text. Only a mail catcher on this same
      // machine (Mailpit for testing) may be used without TLS.
      requireTLS: cfg.SMTP_PORT !== 465 && !['localhost', '127.0.0.1', '::1'].includes(cfg.SMTP_HOST ?? ''),
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD } : undefined,
      // Greet the mail server as esign.ruliba.com, not the container's random hostname (spam filters check this).
      name: new URL(cfg.APP_URL).hostname,
    });
  }
  async send(msg: OutgoingEmail) {
    const from = parseFrom(this.cfg.EMAIL_FROM);
    await this.transporter.sendMail({
      from: msg.onBehalfOf ? { name: viaName(msg.onBehalfOf.name), address: from.address } : this.cfg.EMAIL_FROM,
      replyTo: msg.onBehalfOf ? { name: msg.onBehalfOf.name, address: msg.onBehalfOf.email } : undefined,
      to: msg.to,
      subject: msg.subject,
      // Automatic, one-to-one notifications: no out-of-office replies back to sign@ruliba.com.
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
    });
  }
}

/**
 * Microsoft Graph sendMail from the shared mailbox (sign@ruliba.com), using an Entra app registration
 * with the Mail.Send application permission. Limit that app to this one mailbox with an
 * Exchange Online application access policy (see docs/deployment.md), otherwise it could send as anyone.
 */
export class GraphTransport implements EmailTransport {
  readonly name = 'graph';
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private readonly cfg: AppConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`https://login.microsoftonline.com/${this.cfg.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.GRAPH_CLIENT_ID!,
        client_secret: this.cfg.GRAPH_CLIENT_SECRET!,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok) throw new Error(`Graph token request failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  async send(msg: OutgoingEmail) {
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.cfg.GRAPH_SENDER)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: msg.subject,
          body: { contentType: 'HTML', content: msg.html },
          internetMessageHeaders: [{ name: 'X-Auto-Response-Suppress', value: 'All' }],
          toRecipients: [{ emailAddress: { address: msg.to } }],
          // Exchange may show the mailbox's own display name instead; Reply-To always works.
          ...(msg.onBehalfOf
            ? {
                from: { emailAddress: { name: viaName(msg.onBehalfOf.name), address: this.cfg.GRAPH_SENDER } },
                replyTo: [{ emailAddress: { name: msg.onBehalfOf.name, address: msg.onBehalfOf.email } }],
              }
            : {}),
          attachments: msg.attachments?.map((a) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.filename,
            contentType: a.contentType,
            contentBytes: a.content.toString('base64'),
          })),
        },
        saveToSentItems: true,
      }),
    });
    if (res.status !== 202) throw new Error(`Graph sendMail failed: ${res.status} ${await res.text()}`);
  }
}

export function createTransport(cfg: AppConfig): EmailTransport {
  switch (cfg.EMAIL_TRANSPORT) {
    case 'smtp':
      return new SmtpTransport(cfg);
    case 'graph':
      return new GraphTransport(cfg);
    default:
      return new ConsoleTransport();
  }
}
