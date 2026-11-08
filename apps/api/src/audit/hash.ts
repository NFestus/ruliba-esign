import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface ChainedFields {
  occurredAt: Date;
  type: string;
  documentId?: string | null;
  recipientId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  docSha256?: string | null;
  details?: unknown;
}

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

/** hash(n) = SHA-256( hash(n-1) + "\n" + canonical(event n) ). Changing any past event breaks every later hash. */
export function chainHash(prevHash: string, e: ChainedFields): string {
  const body = canonicalJson({
    occurredAt: e.occurredAt.toISOString(),
    type: e.type,
    documentId: e.documentId ?? null,
    recipientId: e.recipientId ?? null,
    actorUserId: e.actorUserId ?? null,
    actorEmail: e.actorEmail ?? null,
    actorName: e.actorName ?? null,
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
    docSha256: e.docSha256 ?? null,
    details: e.details ?? {},
  });
  return createHash('sha256').update(prevHash + '\n' + body).digest('hex');
}
