# Ruliba Clays eSign

Ruliba Clays' internal e-signature platform: staff prepare documents, send them to colleagues and external parties, and collect legally traceable signatures, with no printing, scanning or courier.

**Status: Phases 0 to 3 complete.** Upload a PDF or Word document, add signers in order or all at once, place fields and send. Supply contracts and other types that need it go through the approval chain first (Procurement Manager, Finance Director, and the Managing Director above a threshold); the reference number is given at the last approval. Staff sign from their dashboard; people outside Ruliba sign from an emailed link after a one-time code, on a phone or a computer. Everyone gets a signed copy sealed by Ruliba Clays Ltd and a certificate of completion; anyone can confirm a copy on the public check page. Templates, reminders, expiry, notifications, reports and a retention review are included, and every step is in the tamper-evident activity log.

What still needs people or production access (lawyer review, penetration test, production server): [docs/handover.md](docs/handover.md) section 7.

## Run it on a laptop

**Windows, quickest:** start Docker Desktop, create `apps/api/.env` from `apps/api/.env.example` (fill in the secrets and the first administrator), then double-click `setup-and-start-test.bat`. Afterwards use `start-test.bat`. Details are logged to `setup-log.txt`.


You need Node.js 22, PostgreSQL 16 and Redis 7 (or `docker compose -f compose.dev.yml up -d`), and LibreOffice if you want Word uploads to work locally.

```bash
npm install
cp apps/api/.env.example apps/api/.env      # fill in (copy on Windows); the app reads this file itself
npm run build -w packages/shared
npm run build -w apps/api
npm run db:migrate && npm run db:seed        # creates tables, starting data and the first admin
npm run dev:api        # http://localhost:3000/api
npm run dev:worker     # sends queued emails
npm run dev:web        # http://localhost:5173
```

Generate each secret (works on Windows, macOS and Linux):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # JWT_*_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # MASTER_KEY
```

The first administrator (from `SEED_ADMIN_*`) must set up an authenticator app and choose a new password at first sign-in.

## Tests

```bash
createdb esign_test     # once
npm test                # shared rules, API unit + end-to-end (real PostgreSQL and Redis), web
```

## Documentation

- [docs/architecture.md](docs/architecture.md): code layout, decision log, security controls
- [docs/erd.svg](docs/erd.svg) ([source](docs/erd.mmd)) and [apps/api/src/db/schema.ts](apps/api/src/db/schema.ts): data model
- [apps/api/drizzle/](apps/api/drizzle/): database schema as SQL migrations
- [docs/openapi.yaml](docs/openapi.yaml): REST API specification
- [docs/deployment.md](docs/deployment.md): installation, email, keys, backups, updates
- [docs/test-plan.md](docs/test-plan.md): automated tests, security checks, user acceptance test, pilot plan
- [docs/user-guide.md](docs/user-guide.md): for staff, with a one-page note for suppliers
- [docs/admin-guide.md](docs/admin-guide.md): people, document types, approval chains, digital seal, reports, retention
- [docs/training-outline.md](docs/training-outline.md): sessions for senders, approvers, administrators and auditors
- [docs/handover.md](docs/handover.md): for the maintainers; open items and later improvements
- [docs/build-vs-buy.md](docs/build-vs-buy.md): comparison with DocuSign, Adobe, Zoho and local options, with 3-year cost

## Phases

| Phase | Scope | State |
|---|---|---|
| 0 | Foundations: sign-in + MFA, users, departments, roles, settings, audit log, email, shell | Done |
| 1 | Upload, fields, signers, email link + code, consent, signing, decline, void, audit trail | Done |
| 2 | Templates, approvals, reminders, dashboard, roles in use, notifications | Done |
| 3 | Sealed PDFs, certificate, verification page, archive, reports, retention | Done |
