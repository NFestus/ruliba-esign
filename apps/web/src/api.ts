/**
 * API client. The access token lives only in memory (never localStorage, so a script injected into
 * the page cannot read a stored token later). The refresh token is an HttpOnly cookie the browser
 * sends to /api/auth only. On a 401 the client refreshes once and retries, but only when the person
 * has been active since the last renewal: background requests alone never keep a sign-in alive.
 */
export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  jobTitle: string | null;
  departmentId: string | null;
  roles: string[];
  mfaEnabled: boolean;
  mfaMethod: 'TOTP' | 'SMS' | null;
  mfaRequired: boolean;
  mustChangePassword: boolean;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  /** Ends here unless renewed by activity. */
  idleExpiresAt: string;
  /** Ends here in any case (maximum sign-in length). */
  sessionExpiresAt: string;
  idleMinutes: number;
  user: PublicUser;
}

/** Why the last session ended, when the server said so (shown on the sign-in page). */
export type EndReason = 'idle' | 'expired' | 'revoked' | null;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: { code?: string; errors?: { field: string; message: string }[] } = {},
  ) {
    super(message);
  }
  fieldError(field: string) {
    return this.body.errors?.find((e) => e.field === field)?.message;
  }
}

let accessToken: string | null = null;
let onSession: (s: Session | null, reason: EndReason) => void = () => undefined;
let refreshing: Promise<Session | null> | null = null;
let lastActivity = Date.now();
let lastRenewal = 0;

export function setSessionListener(fn: (s: Session | null, reason: EndReason) => void) {
  onSession = fn;
}

export function applySession(s: Session | null, reason: EndReason = null) {
  accessToken = s?.accessToken ?? null;
  if (s) lastRenewal = Date.now();
  onSession(s, reason);
}

/** Called on clicks, typing and scrolling. */
export function markActivity() {
  lastActivity = Date.now();
}
export const activeSinceRenewal = () => lastActivity > lastRenewal;
export const sinceRenewal = () => Date.now() - lastRenewal;

async function parse(res: Response) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = Array.isArray(body?.message) ? body.message.join(' ') : (body?.message ?? 'Something went wrong. Try again.');
    throw new ApiError(res.status, res.status === 429 ? 'Too many tries. Wait a minute and try again.' : msg, body ?? {});
  }
  return body;
}

const REASONS: Record<string, EndReason> = { SESSION_IDLE: 'idle', SESSION_EXPIRED: 'expired' };

/**
 * Swaps the refresh cookie for a new access token. Tabs share the cookie, so renewals are queued
 * across tabs (a token renewed twice at once would look stolen and end the sign-in).
 */
export function refreshSession(): Promise<Session | null> {
  const run = async (): Promise<Session | null> => {
    let res: Response;
    try {
      res = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'x-esign-csrf': '1' }, credentials: 'same-origin' });
    } catch {
      return null; // offline or server unreachable: keep the current state, try again later
    }
    if (res.ok) {
      const s = (await res.json()) as Session;
      applySession(s);
      return s;
    }
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    applySession(null, res.status === 401 ? (REASONS[body.code ?? ''] ?? (accessToken ? 'revoked' : null)) : null);
    return null;
  };
  refreshing ??= (navigator.locks ? navigator.locks.request('esign-refresh', run) : run()).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; retry?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && init.retry !== false && accessToken && !path.startsWith('/auth/') && activeSinceRenewal()) {
    const s = await refreshSession();
    if (s) return api<T>(path, { ...init, retry: false });
  }
  return parse(res);
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-esign-csrf': '1' }, credentials: 'same-origin' }).catch(() => undefined);
  applySession(null);
}

/** Binary download (PDF) with the staff session. */
export async function apiBytes(path: string): Promise<ArrayBuffer> {
  const go = () => fetch(`/api${path}`, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {}, credentials: 'same-origin' });
  let res = await go();
  if (res.status === 401 && accessToken && activeSinceRenewal() && (await refreshSession())) res = await go();
  if (!res.ok) await parse(res);
  return res.arrayBuffer();
}

/** Multipart upload (document files). */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const go = () => fetch(`/api${path}`, { method: 'POST', body: form, headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {}, credentials: 'same-origin' });
  let res = await go();
  if (res.status === 401 && accessToken && activeSinceRenewal() && (await refreshSession())) res = await go();
  return parse(res);
}

/** Calls made inside a signing session use the signing token, not the staff session. */
export function signApi(signToken: string) {
  const headers = { authorization: `Bearer ${signToken}` };
  return {
    get: async <T,>(path: string): Promise<T> => parse(await fetch(`/api/sign/session${path}`, { headers })),
    post: async <T,>(path: string, body: unknown): Promise<T> =>
      parse(await fetch(`/api/sign/session${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })),
    file: async (): Promise<ArrayBuffer> => {
      const res = await fetch('/api/sign/session/file', { headers });
      if (!res.ok) await parse(res);
      return res.arrayBuffer();
    },
  };
}

/** Public link calls (no session at all). */
export async function publicApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return parse(res);
}
