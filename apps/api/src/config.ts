import { z } from 'zod';

/**
 * All configuration comes from environment variables, validated at start-up.
 * The app refuses to start with a missing or weak secret rather than running insecurely.
 */
const base64Key = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .refine((v) => Buffer.from(v, 'base64').length === 32, `${name} must be 32 random bytes, base64-encoded (openssl rand -base64 32)`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1), // hops in front (Caddy = 1)

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_MFA_SECRET: z.string().min(32, 'JWT_MFA_SECRET must be at least 32 characters'),
  JWT_SIGN_SECRET: z.string().min(32, 'JWT_SIGN_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(7),
  /** How long the activation link emailed to a new user works. */
  ACTIVATION_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  /**
   * Email domains of Ruliba staff, comma-separated (e.g. "ruliba.com"). When set, a sender adding a new
   * internal signer must use one of them; administrators adding users are not limited.
   */
  INTERNAL_EMAIL_DOMAINS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)),
  /** How long a password reset link works. */
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

  /** Wraps per-file keys and MFA secrets. Losing it = losing the data. Back it up offline. */
  MASTER_KEY: base64Key('MASTER_KEY'),

  /** Encrypted document files. A Docker volume in production, backed up nightly. */
  STORAGE_DIR: z.string().default('./data/files'),
  /** clamd for virus scanning. Required in production. */
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  /** Word to PDF: Gotenberg in production, local LibreOffice (soffice) in development, or none. */
  CONVERTER: z.enum(['gotenberg', 'soffice', 'none']).default('soffice'),
  GOTENBERG_URL: z.string().url().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(25),

  EMAIL_TRANSPORT: z.enum(['console', 'smtp', 'graph']).default('console'),
  EMAIL_FROM: z.string().default('Ruliba Clays eSign <sign@ruliba.com>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  GRAPH_TENANT_ID: z.string().optional(),
  GRAPH_CLIENT_ID: z.string().optional(),
  GRAPH_CLIENT_SECRET: z.string().optional(),
  GRAPH_SENDER: z.string().default('sign@ruliba.com'),

  /**
   * Text messages for two-step sign-in codes. "console" prints them to the worker log (development);
   * in production SMS sign-in is offered only when a real provider is configured.
   */
  SMS_TRANSPORT: z.enum(['console', 'africastalking', 'twilio']).default('console'),
  AT_USERNAME: z.string().optional(), // Africa's Talking; "sandbox" uses their test environment
  AT_API_KEY: z.string().optional(),
  AT_SENDER_ID: z.string().optional(), // registered sender name, e.g. RULIBA; empty = provider default
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(), // a Twilio number (+1...) or an approved alphanumeric sender

  /** Independent mailbox (ideally outside IT's control, e.g. the MD or the auditor) for the daily audit-log fingerprint. */
  AUDIT_ANCHOR_EMAIL: z.string().email().optional(),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_NAME: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  // A line left blank in .env (e.g. "AUDIT_ANCHOR_EMAIL=") means "not set".
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration is invalid:\n${lines}`);
  }
  const cfg = parsed.data;
  if (cfg.EMAIL_TRANSPORT === 'smtp' && !cfg.SMTP_HOST) throw new Error('EMAIL_TRANSPORT=smtp needs SMTP_HOST');
  if (cfg.EMAIL_TRANSPORT === 'graph' && !(cfg.GRAPH_TENANT_ID && cfg.GRAPH_CLIENT_ID && cfg.GRAPH_CLIENT_SECRET)) {
    throw new Error('EMAIL_TRANSPORT=graph needs GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET');
  }
  if (cfg.NODE_ENV === 'production' && !cfg.CLAMAV_HOST) throw new Error('CLAMAV_HOST is required in production: every upload must be virus-scanned');
  if (cfg.SMS_TRANSPORT === 'africastalking' && !(cfg.AT_USERNAME && cfg.AT_API_KEY)) throw new Error('SMS_TRANSPORT=africastalking needs AT_USERNAME and AT_API_KEY');
  if (cfg.SMS_TRANSPORT === 'twilio' && !(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.TWILIO_FROM)) {
    throw new Error('SMS_TRANSPORT=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');
  }
  if (cfg.CONVERTER === 'gotenberg' && !cfg.GOTENBERG_URL) throw new Error('CONVERTER=gotenberg needs GOTENBERG_URL');
  if (cfg.NODE_ENV === 'production' && cfg.EMAIL_TRANSPORT === 'console') {
    throw new Error('EMAIL_TRANSPORT=console is not allowed in production');
  }
  if (env === process.env) cached = cfg;
  return cfg;
}

/** SMS sign-in is offered only where a text can actually reach a phone (console is fine outside production). */
export function smsAvailable(cfg: AppConfig) {
  return cfg.SMS_TRANSPORT !== 'console' || cfg.NODE_ENV !== 'production';
}

export const CONFIG = Symbol('CONFIG');
