import './env';
import { passwordProblems } from '@ruliba/shared';
import { eq } from 'drizzle-orm';
import { AuditService } from './audit/audit.service';
import { hashPassword } from './auth/passwords';
import { rememberPassword } from './auth/password-history';
import { createDb } from './db/db';
import { approvalPolicies, approvalPolicySteps, departments, documentTypes, settings, userRoles, users } from './db/schema';

/**
 * First-run set-up. Safe to run again: it only adds what is missing.
 * Creates starting departments and document types, the supply-contract approval chain,
 * and the first administrator from SEED_ADMIN_EMAIL / SEED_ADMIN_NAME / SEED_ADMIN_PASSWORD.
 * Codes and names are starting points; the administrator can change them in Settings.
 */
const DEPARTMENTS = [
  { code: 'PRO', name: 'Procurement' },
  { code: 'FIN', name: 'Finance' },
  { code: 'ADM', name: 'Administration' },
  { code: 'HR', name: 'Human Resources' },
  { code: 'PRD', name: 'Production' },
  { code: 'SAL', name: 'Sales' },
  { code: 'IT', name: 'Information Technology' },
];

const DOCUMENT_TYPES = [
  { code: 'CON', name: 'Supply contract', requiresApproval: true },
  { code: 'PO', name: 'Purchase order', requiresApproval: true },
  { code: 'AGR', name: 'Agreement', requiresApproval: true },
  { code: 'NDA', name: 'Non-disclosure agreement', requiresApproval: true },
  { code: 'FRM', name: 'Internal form', requiresApproval: false },
  // Shown so senders see it is excluded; a lawyer confirms the full list (Law 18/2010).
  { code: 'POA', name: 'Power of attorney (not for e-signature)', requiresApproval: true, eSignAllowed: false },
];

export async function seed(url: string, log: (m: string) => void = console.log) {
  const { pool, db } = createDb(url, 2);
  const audit = new AuditService({ db });
  try {
    await db.insert(departments).values(DEPARTMENTS).onConflictDoNothing({ target: departments.code });
    await db.insert(documentTypes).values(DOCUMENT_TYPES).onConflictDoNothing({ target: documentTypes.code });

    // Agreed chain: Procurement Manager -> Finance Director, plus Managing Director above a threshold.
    const con = await db.query.documentTypes.findFirst({ where: eq(documentTypes.code, 'CON') });
    const existing = con && (await db.query.approvalPolicies.findFirst({ where: eq(approvalPolicies.documentTypeId, con.id) }));
    if (con && !existing) {
      const [p] = await db.insert(approvalPolicies).values({ name: 'Supply contracts', documentTypeId: con.id }).returning();
      await db.insert(approvalPolicySteps).values([
        { policyId: p.id, stepOrder: 1, label: 'Procurement Manager' },
        { policyId: p.id, stepOrder: 2, label: 'Finance Director' },
        // Threshold not decided yet. 0 means "every contract goes to the MD", the safe default.
        // The approvals page warns until the real amount and currency are entered.
        { policyId: p.id, stepOrder: 3, label: 'Managing Director', minAmount: '0.00' },
      ]);
    }
    await db.insert(settings).values({ key: 'approval', value: { currency: null } }).onConflictDoNothing({ target: settings.key });

    const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    const name = process.env.SEED_ADMIN_NAME?.trim();
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (email && name && password) {
      const found = await db.query.users.findFirst({ where: eq(users.email, email) });
      if (!found) {
        const problems = passwordProblems(password, email);
        if (problems.length) throw new Error(`SEED_ADMIN_PASSWORD is too weak: ${problems.join(' ')}`);
        const it = await db.query.departments.findFirst({ where: eq(departments.code, 'IT') });
        const [u] = await db
          .insert(users)
          .values({
            email,
            fullName: name,
            departmentId: it?.id ?? null,
            passwordHash: await hashPassword(password),
            mustChangePassword: true, // the seed password sits in a file: replace it at first sign-in
            activatedAt: new Date(),
          })
          .returning();
        await db.insert(userRoles).values({ userId: u.id, role: 'ADMIN' });
        await rememberPassword(db, u.id, u.passwordHash);
        await audit.record({ type: 'system.first_admin_created', details: { userId: u.id, email } });
        log(`Created first administrator ${email}. At first sign-in they set up two-step sign-in and a new password.`);
      }
    } else {
      log('SEED_ADMIN_* not set: no administrator created.');
    }
    log('Seed complete.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  seed(url).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
