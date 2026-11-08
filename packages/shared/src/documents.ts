import { z } from 'zod';

/**
 * Rules shared by the web app and the API for preparing and signing documents.
 */

export const FIELD_TYPES = ['SIGNATURE', 'INITIALS', 'STAMP', 'DATE_SIGNED', 'NAME', 'TEXT', 'CHECKBOX', 'DROPDOWN'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_LABELS: Record<FieldType, string> = {
  SIGNATURE: 'Signature',
  INITIALS: 'Initials',
  STAMP: 'Stamp',
  DATE_SIGNED: 'Date signed',
  NAME: 'Name',
  TEXT: 'Text',
  CHECKBOX: 'Checkbox',
  DROPDOWN: 'Dropdown',
};

/** Default size of a new field as a fraction of an A4 page (width, height). */
export const FIELD_DEFAULT_SIZE: Record<FieldType, [number, number]> = {
  SIGNATURE: [0.26, 0.06],
  INITIALS: [0.1, 0.05],
  STAMP: [0.17, 0.11],
  DATE_SIGNED: [0.22, 0.03],
  NAME: [0.26, 0.03],
  TEXT: [0.26, 0.03],
  CHECKBOX: [0.03, 0.022],
  DROPDOWN: [0.22, 0.03],
};

/** Fields the system fills in at signing time; the signer does not type them. */
export const AUTO_FIELDS: readonly FieldType[] = ['DATE_SIGNED', 'NAME'];

export const DATE_LOCALES = {
  'en-GB': 'English (2 November 2026)',
  'en-US': 'English, US (November 2, 2026)',
  'fr-FR': 'Français (2 novembre 2026)',
} as const;
export type DateLocale = keyof typeof DATE_LOCALES;

export function formatSigningDate(d: Date, locale: string): string {
  const l = locale in DATE_LOCALES ? locale : 'en-GB';
  return new Intl.DateTimeFormat(l, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Kigali' }).format(d);
}

export const SENSITIVITIES = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export const SENSITIVITY_LABELS = { INTERNAL: 'Internal', CONFIDENTIAL: 'Confidential', RESTRICTED: 'Restricted' } as const;

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
const fraction = z.number().min(0).max(1);

export const createDocumentSchema = z.object({
  title: z.string().trim().min(2, 'Give the document a title.').max(200),
  documentTypeId: z.string().uuid('Choose a document type.'),
  sensitivity: z.enum(SENSITIVITIES).default('INTERNAL'),
  locale: z.enum(Object.keys(DATE_LOCALES) as [DateLocale, ...DateLocale[]]).default('en-GB'),
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  counterparty: z.string().trim().max(200).nullable().optional(),
  contractValue: z.number().nonnegative().max(1e15).nullable().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable().optional(),
  emailSubject: z.string().trim().max(200).nullable().optional(),
  emailMessage: z.string().trim().max(2000).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  sensitivity: z.enum(SENSITIVITIES).optional(),
  locale: z.enum(Object.keys(DATE_LOCALES) as [DateLocale, ...DateLocale[]]).optional(),
});
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const recipientsSchema = z
  .object({
    routingMode: z.enum(['SEQUENTIAL', 'PARALLEL', 'MIXED']),
    recipients: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          role: z.enum(['SIGNER', 'CC']),
          fullName: z.string().trim().min(2, 'Enter the full name.').max(160),
          email,
          stepOrder: z.number().int().min(1).max(20).default(1),
        }),
      )
      .min(1, 'Add at least one signer.')
      .max(20, 'Up to 20 people per document.'),
  })
  .refine((v) => v.recipients.some((r) => r.role === 'SIGNER'), { message: 'Add at least one signer.', path: ['recipients'] })
  .refine(
    (v) => {
      const signers = v.recipients.filter((r) => r.role === 'SIGNER').map((r) => r.email);
      return new Set(signers).size === signers.length;
    },
    { message: 'The same email appears twice. Each signer needs their own email.', path: ['recipients'] },
  );
export type RecipientsInput = z.infer<typeof recipientsSchema>;

export const fieldSchema = z
  .object({
    recipientId: z.string().uuid(),
    type: z.enum(FIELD_TYPES),
    page: z.number().int().min(1).max(500),
    x: fraction,
    y: fraction,
    width: z.number().min(0.005).max(1),
    height: z.number().min(0.005).max(1),
    required: z.boolean().default(true),
    label: z.string().trim().max(120).nullable().optional(),
    options: z.array(z.string().trim().min(1).max(80)).max(30).nullable().optional(),
  })
  .refine((f) => f.x + f.width <= 1.001 && f.y + f.height <= 1.001, { message: 'A field reaches past the edge of the page.' })
  .refine((f) => f.type !== 'DROPDOWN' || (f.options?.length ?? 0) >= 2, { message: 'A dropdown needs at least two choices.' });

export const fieldsSchema = z.object({ fields: z.array(fieldSchema).max(300) });
export type FieldInput = z.infer<typeof fieldSchema>;

export const sendDocumentSchema = z.object({
  emailSubject: z.string().trim().max(200).nullable().optional(),
  emailMessage: z.string().trim().max(2000).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(180).default(30),
  /** Email a reminder to anyone who has not signed after this many days (null = no reminders). */
  reminderEveryDays: z.number().int().min(1).max(30).nullable().default(3),
});

export const approveSchema = z.object({ comment: z.string().trim().max(500).nullable().optional() });

export const voidSchema = z.object({ reason: z.string().trim().min(3, 'Say why, in a few words.').max(500) });
export const declineSchema = z.object({ reason: z.string().trim().min(3, 'Say why, in a few words.').max(500) });
export const otpVerifySchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email.') });

/** A signature or initials image is always a PNG data URL: drawn, typed and uploaded signatures are all turned into PNG in the browser. */
export const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
export const MAX_SIGNATURE_BYTES = 1_000_000;

export const completeSigningSchema = z.object({
  values: z
    .array(
      z.object({
        fieldId: z.string().uuid(),
        value: z.string().max(500).nullable().optional(),
        image: z.string().max(1_400_000).regex(PNG_DATA_URL, 'Signature must be a PNG image.').nullable().optional(),
        method: z.enum(['DRAWN', 'TYPED', 'UPLOADED']).nullable().optional(),
        /** Stamp fields, staff: one of the Ruliba stamps this person may use. */
        stampId: z.string().uuid().nullable().optional(),
      }),
    )
    .max(300),
});
export type CompleteSigningInput = z.infer<typeof completeSigningSchema>;

export const savedSignatureSchema = z.object({
  kind: z.enum(['SIGNATURE', 'INITIALS']),
  method: z.enum(['DRAWN', 'TYPED', 'UPLOADED']),
  image: z.string().max(1_400_000).regex(PNG_DATA_URL, 'Signature must be a PNG image.'),
});

/** Company stamps that the administrator uploads; only the listed people may apply them. */
export const stampSchema = z.object({
  name: z.string().trim().min(2, 'Name the stamp, e.g. "Ruliba Clays official stamp".').max(120),
  image: z.string().max(1_400_000).regex(PNG_DATA_URL, 'The stamp must be a PNG image.'),
  userIds: z.array(z.string().uuid()).max(200).default([]),
});
export const stampUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  active: z.boolean().optional(),
  userIds: z.array(z.string().uuid()).max(200).optional(),
});

/** Personal folders: a person files documents they can see, for their own view only. */
export const folderSchema = z.object({ name: z.string().trim().min(1, 'Name the folder.').max(80) });
export const fileDocumentSchema = z.object({ folderId: z.string().uuid().nullable() });

/**
 * Consent to use electronic records and signatures, shown before a signer can fill any field.
 * The exact text and its version are stored in the audit log for each signer.
 * DRAFT wording: to be approved by Ruliba's lawyer before the pilot (Law No. 18/2010 and Law No. 058/2021).
 */
export const CONSENT_VERSION = '2026-11-v1-draft';
export const CONSENT_TEXT =
  'I agree to receive, review and sign this document electronically. I understand that my electronic signature ' +
  'has the same effect as my handwritten signature, and that Ruliba Clays Ltd records my name, email address, ' +
  'IP address, device and the times of my actions as evidence of this signing. I can ask the sender for a paper ' +
  'copy, or decline to sign, at any time before I finish.';
