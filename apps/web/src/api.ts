/**
 * API client. The access token lives only in memory (never localStorage, so a script injected into
 * the page cannot read a stored token later). The refresh token is an HttpOnly cookie the browser
 * sends to /api/auth only. On a 401 the client refreshes once and retries.
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
  user: PublicUser;
}

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
let onSession: (s: Session | null) => void = () => undefined;
let refreshing: Promise<Session | null> | null = null;

export function setSessionListener(fn: (s: Session | null) => void) {
  onSession = fn;
}

export function applySession(s: Session | null) {
  accessToken = s?.accessToken ?? null;
  onSession(s);
}

async function parse(res: Response) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = Array.isArray(body?.message) ? body.message.join(' ') : (body?.message ?? 'Something went wrong. Try again.');
    throw new ApiError(res.status, res.status === 429 ? 'Too many tries. Wait a minute and try again.' : msg, body ?? {});
  }
  return body;
}

export function refreshSession(): Promise<Session | null> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', headers: { 'x-esign-csrf': '1' }, credentials: 'same-origin' })
    .then(async (res) => (res.ok ? ((await res.json()) as Session) : null))
    .catch(() => null)
    .then((s) => {
      applySession(s);
      return s;
    })
    .finally(() => {
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
  if (res.status === 401 && init.retry !== false && accessToken && !path.startsWith('/auth/')) {
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
  if (res.status === 401 && accessToken && (await refreshSession())) res = await go();
  if (!res.ok) await parse(res);
  return res.arrayBuffer();
}

/** Multipart upload (document files). */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const go = () => fetch(`/api${path}`, { method: 'POST', body: form, headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {}, credentials: 'same-origin' });
  let res = await go();
  if (res.status === 401 && accessToken && (await refreshSession())) res = await go();
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
