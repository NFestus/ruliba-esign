import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../auth/decorators';

export interface DocAccessRow {
  senderId: string;
  departmentId?: string;
  status?: string;
  recipients: { userId: string | null; email: string }[];
}

/**
 * Who may see a document (Phase 1):
 *  - the sender;
 *  - anyone it is addressed to (internal staff matched by account or email);
 *  - Auditors (read-only, everything).
 * Administrators manage the system but do not read documents unless they also hold one of the above.
 *  - Approvers: every sent (non-draft) document of their own department.
 */
export function canView(user: AuthUser, doc: DocAccessRow): boolean {
  if (doc.senderId === user.id) return true;
  if (user.roles.includes('AUDITOR')) return true;
  // Approvers (department heads) read every sent document of their own department.
  if (user.roles.includes('APPROVER') && user.departmentId && doc.departmentId === user.departmentId && doc.status !== 'DRAFT') return true;
  return doc.recipients.some((r) => r.userId === user.id || r.email === user.email);
}

export function assertView(user: AuthUser, doc: DocAccessRow | undefined | null): asserts doc is DocAccessRow {
  // Same answer for "does not exist" and "not yours": IDs reveal nothing.
  if (!doc || !canView(user, doc)) throw new NotFoundException('Document not found.');
}

export function assertSender(user: AuthUser, doc: { senderId: string }) {
  if (doc.senderId !== user.id) throw new ForbiddenException('Only the person who prepared this document can change it.');
}
