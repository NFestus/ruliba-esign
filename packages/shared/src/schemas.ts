import { z } from 'zod';
import { ROLES } from './roles';
import { PASSWORD_MIN_LENGTH, passwordProblems } from './password';

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
const code = z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/, 'Use 2 to 5 capital letters.');

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({
  mfaToken: z.string().min(10),
  code: z.string().trim().regex(/^(\d{6}|[A-Z0-9]{5}-[A-Z0-9]{5})$/i, 'Enter the 6-digit code or a recovery code.'),
});

export const mfaConfirmSchema = z.object({
  mfaToken: z.string().min(10).optional(),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your app.'),
});

export const newPasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(128),
  })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'Choose a different password.', path: ['newPassword'] });

/** A new user sets their first password from the emailed activation link. */
export const activateAccountSchema = z.object({
  token: z.string().trim().min(20).max(200),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(128),
});
export type ActivateAccountInput = z.infer<typeof activateAccountSchema>;

/** "Forgot your password?": always answered the same way, whether or not the email has an account. */
export const forgotPasswordSchema = z.object({ email });

/** A new password chosen from an emailed reset link. */
export const resetPasswordSchema = activateAccountSchema;
export type ResetPasswordInput = ActivateAccountInput;

/**
 * Mobile number for SMS sign-in codes, in international form. Spaces and dashes are removed;
 * a Rwandan number typed as 07XXXXXXXX becomes +2507XXXXXXXX.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s().-]/g, ''))
  .transform((v) => (/^07\d{8}$/.test(v) ? `+250${v.slice(1)}` : v.startsWith('00') ? `+${v.slice(2)}` : v))
  .refine((v) => /^\+[1-9]\d{7,14}$/.test(v), 'Enter a mobile number in international form, for example +250 788 123 456.');

export const mfaSmsSetupSchema = z.object({
  mfaToken: z.string().min(10).optional(),
  phone: phoneSchema,
});

export const mfaTokenSchema = z.object({ mfaToken: z.string().min(10) });

export const createUserSchema = z.object({
  email,
  fullName: z.string().trim().min(2).max(160),
  jobTitle: z.string().trim().max(120).optional().nullable(),
  departmentId: z.string().uuid().nullable().optional(),
  roles: z.array(z.enum(ROLES)).min(1, 'Give the user at least one role.'),
  mfaRequired: z.boolean().optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** A sender adds a Ruliba colleague who has no account yet, as an internal signer (Signer role only). */
export const createSignerSchema = z.object({
  email,
  fullName: z.string().trim().min(2, 'Enter the full name.').max(160),
});
export type CreateSignerInput = z.infer<typeof createSignerSchema>;

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(160).optional(),
  jobTitle: z.string().trim().max(120).optional().nullable(),
  departmentId: z.string().uuid().nullable().optional(),
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  mfaRequired: z.boolean().optional(),
});

export const departmentSchema = z.object({
  code,
  name: z.string().trim().min(2).max(120),
  active: z.boolean().optional(),
});

export const documentTypeSchema = z.object({
  code,
  name: z.string().trim().min(2).max(120),
  requiresApproval: z.boolean().default(true),
  eSignAllowed: z.boolean().default(true),
  minSignatureLevel: z.enum(['PLATFORM', 'GOVCA']).default('PLATFORM'),
  retentionYears: z.number().int().min(1).max(100).nullable().optional(),
  active: z.boolean().optional(),
});

/**
 * Approval thresholds live on each chain step (minAmount: "only when the value is above").
 * The currency those amounts are in is one organisation-wide setting. Null until Ruliba sets it;
 * until then, steps with an amount cannot be evaluated and the app warns the administrator.
 */
export const approvalSettingsSchema = z.object({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, e.g. RWF.').nullable(),
});
export type ApprovalSettings = z.infer<typeof approvalSettingsSchema>;

export const approvalPolicySchema = z.object({
  name: z.string().trim().min(2).max(120),
  documentTypeId: z.string().uuid().nullable(),
  departmentId: z.string().uuid().nullable(),
  active: z.boolean().default(true),
  steps: z
    .array(
      z.object({
        label: z.string().trim().min(2).max(120),
        approverUserId: z.string().uuid().nullable(),
        minAmount: z.number().nonnegative().nullable(),
      }),
    )
    .min(1)
    .max(10),
});
export type ApprovalPolicyInput = z.infer<typeof approvalPolicySchema>;

export { passwordProblems };
