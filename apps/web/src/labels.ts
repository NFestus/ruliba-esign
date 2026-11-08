/** Plain-language names used across the app, so the same thing is always called the same. */

export const DOC_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'off' | 'danger' | 'info' }> = {
  DRAFT: { label: 'Draft', tone: 'off' },
  PENDING_APPROVAL: { label: 'Awaiting approval', tone: 'info' },
  IN_PROGRESS: { label: 'In progress', tone: 'info' },
  COMPLETED: { label: 'Completed', tone: 'ok' },
  DECLINED: { label: 'Declined', tone: 'danger' },
  VOIDED: { label: 'Cancelled', tone: 'off' },
  EXPIRED: { label: 'Expired', tone: 'warn' },
};

export const RECIPIENT_STATUS: Record<string, string> = {
  WAITING: 'Waiting for earlier signers',
  SENT: 'Invited',
  VIEWED: 'Opened',
  COMPLETED: 'Signed',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
};

/** Signer colours on the page. Distinct in hue and lightness; text on them stays dark. */
export const SIGNER_COLOURS = ['#f26b3a', '#2f7fd8', '#22a06b', '#9b59b6', '#d4a017', '#e0457b', '#00a3a3', '#7a869a'];

export const EVENT_LABELS: Record<string, string> = {
  'document.created': 'Uploaded the document',
  'document.details_changed': 'Changed the details',
  'document.recipients_set': 'Set the signers',
  'document.fields_set': 'Placed the fields',
  'document.sent': 'Sent for signing',
  'document.file_opened': 'Opened a file',
  'document.viewed': 'Opened the document',
  'document.completed': 'Everyone signed: sealed copy and certificate made',
  'document.approved': 'Approved: reference number given, sent to signers',
  'document.expired': 'Expired: links stopped working',
  'document.files_purged': 'Files deleted at the end of the retention period',
  'document.submitted_for_approval': 'Sent for internal approval',
  'approval.approved': 'Approved',
  'approval.returned': 'Returned for changes',
  'approval.requested': 'Asked to approve',
  'template.created': 'Saved as a template',
  'template.used': 'Created from a template',
  'verify.checked': 'Someone checked a copy',
  'document.voided': 'Cancelled the document',
  'document.draft_deleted': 'Deleted the draft',
  'document.upload_refused': 'Upload refused',
  'recipient.invited': 'Invited to sign',
  'recipient.reminded': 'Sent the link again',
  'recipient.link_opened': 'Opened the signing link',
  'recipient.code_sent': 'One-time code emailed',
  'recipient.code_failed': 'Wrong one-time code',
  'recipient.verified': 'Identity confirmed',
  'recipient.consented': 'Agreed to sign electronically',
  'recipient.signed': 'Signed',
  'recipient.declined': 'Declined to sign',
};

export const FILE_LABEL: Record<string, string> = {
  ORIGINAL: 'Original as uploaded',
  CONVERTED: 'PDF made from the Word file',
  SIGNED: 'Signed copy with signing record',
  SEALED: 'Signed and sealed copy',
  CERTIFICATE: 'Certificate of completion',
};

export function eventLabel(type: string, details?: Record<string, unknown>) {
  if (type === 'recipient.verified') return details?.method === 'account' ? 'Identity confirmed (staff sign-in)' : 'Identity confirmed (emailed code)';
  return EVENT_LABELS[type] ?? type;
}
