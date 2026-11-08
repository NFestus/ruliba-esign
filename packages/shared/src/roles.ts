export const ROLES = ['ADMIN', 'SENDER', 'APPROVER', 'SIGNER', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];

/** Plain-language labels shown in the UI. */
export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Administrator',
  SENDER: 'Sender',
  APPROVER: 'Approver',
  SIGNER: 'Signer',
  AUDITOR: 'Auditor (read-only)',
};

/** Roles that must use an authenticator app. Others may opt in. */
export const MFA_REQUIRED_ROLES: readonly Role[] = ['ADMIN', 'AUDITOR'];

export function mfaRequiredFor(roles: readonly string[]): boolean {
  return roles.some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r));
}
