import { describe, expect, it } from 'vitest';
import { formatReference, parseReference } from './reference';
import { passwordProblems } from './password';
import { mfaRequiredFor } from './roles';
import { approvalPolicySchema, createUserSchema, phoneSchema } from './schemas';

describe('reference numbers', () => {
  it('formats in the Ruliba format with 4-digit padding', () => {
    expect(formatReference('PRO', 'CON', 2026, 1)).toBe('RCL/PRO/CON/2026/0001');
    expect(formatReference('FIN', 'PO', 2027, 12345)).toBe('RCL/FIN/PO/2027/12345');
  });
  it('rejects bad parts', () => {
    expect(() => formatReference('pro', 'CON', 2026, 1)).toThrow();
    expect(() => formatReference('PRO', 'CON', 2026, 0)).toThrow();
  });
  it('parses back what it formats', () => {
    expect(parseReference('rcl/pro/con/2026/0042')).toEqual({ dept: 'PRO', type: 'CON', year: 2026, number: 42 });
    expect(parseReference('RCL-PRO-CON-2026-0042')).toBeNull();
  });
});

describe('password rule', () => {
  it('accepts a long passphrase', () => {
    expect(passwordProblems('Brick kiln at Ruhanga 7', 'jane@ruliba.com')).toEqual([]);
  });
  it('rejects short, single-class and company-name passwords', () => {
    expect(passwordProblems('short1A')).not.toEqual([]);
    expect(passwordProblems('alllowercaseletters')).not.toEqual([]);
    expect(passwordProblems('Ruliba2026!!xyz')).not.toEqual([]);
  });
});

describe('roles', () => {
  it('requires MFA for admins and auditors only', () => {
    expect(mfaRequiredFor(['ADMIN'])).toBe(true);
    expect(mfaRequiredFor(['SENDER', 'AUDITOR'])).toBe(true);
    expect(mfaRequiredFor(['SENDER', 'SIGNER'])).toBe(false);
  });
});

describe('schemas', () => {
  it('lower-cases emails', () => {
    const u = createUserSchema.parse({ email: ' Jane@Ruliba.COM ', fullName: 'Jane', roles: ['SENDER'] });
    expect(u.email).toBe('jane@ruliba.com');
  });
  it('requires at least one approval step', () => {
    expect(approvalPolicySchema.safeParse({ name: 'x', documentTypeId: null, departmentId: null, steps: [] }).success).toBe(false);
  });
});

describe('phoneSchema', () => {
  it('accepts international numbers and turns Rwandan 07 numbers into +250', () => {
    expect(phoneSchema.parse('+250 788 123 456')).toBe('+250788123456');
    expect(phoneSchema.parse('0788-123-456')).toBe('+250788123456');
    expect(phoneSchema.parse('00250788123456')).toBe('+250788123456');
    expect(phoneSchema.parse('+1 (415) 555-0100')).toBe('+14155550100');
  });
  it('refuses numbers that are not in international form', () => {
    for (const bad of ['12345', '788123456', '+0123456789', 'call me']) expect(phoneSchema.safeParse(bad).success).toBe(false);
  });
});
