export interface Recipient {
  id: string;
  role: 'SIGNER' | 'CC' | 'APPROVER';
  stepOrder: number;
  fullName: string;
  email: string;
  userId: string | null;
  isExternal: boolean;
  status: string;
  sentAt: string | null;
  viewedAt: string | null;
  completedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
}

export interface Field {
  id?: string;
  key?: string; // local id while editing
  recipientId: string;
  type: 'SIGNATURE' | 'INITIALS' | 'STAMP' | 'DATE_SIGNED' | 'NAME' | 'TEXT' | 'CHECKBOX' | 'DROPDOWN';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  label?: string | null;
  options?: string[] | null;
}

export interface DocFile {
  id: string;
  kind: 'ORIGINAL' | 'CONVERTED' | 'SIGNED' | 'SEALED' | 'PREPARED' | 'CERTIFICATE';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number | null;
  createdAt: string;
}

export interface DocEvent {
  id: number;
  type: string;
  occurredAt: string;
  actorName: string | null;
  actorEmail: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

export interface DocumentDetail {
  id: string;
  myFolderId: string | null;
  title: string;
  status: string;
  referenceNo: string | null;
  sensitivity: string;
  routingMode: 'SEQUENTIAL' | 'PARALLEL' | 'MIXED';
  locale: string;
  counterparty: string | null;
  contractValue: string | null;
  currency: string | null;
  reminderEveryDays: number | null;
  purgedAt: string | null;
  emailSubject: string | null;
  emailMessage: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  completedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
  isSender: boolean;
  documentType: { code: string; name: string; requiresApproval: boolean };
  department: { code: string; name: string };
  sender: { id: string; fullName: string; email: string };
  recipients: Recipient[];
  fields: Field[];
  files: DocFile[];
  events: DocEvent[];
}

export interface DocRow {
  id: string;
  title: string;
  status: string;
  referenceNo: string | null;
  counterparty: string | null;
  updatedAt: string;
  senderId: string;
  senderName: string;
  waitingForMe: boolean;
  myAction: 'sign' | 'approve' | null;
  folderId: string | null;
  departmentName?: string;
  recipients: { fullName: string; role: string; status: string; stepOrder: number }[];
}

export const pageCountOf = (d: DocumentDetail) => d.files.find((f) => f.kind === 'CONVERTED')?.pageCount ?? d.files.find((f) => f.kind === 'ORIGINAL')?.pageCount ?? 0;
