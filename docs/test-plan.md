# Test plan

How Ruliba Clays eSign is tested before each release and before the Procurement pilot.
Automated tests run on every change (CI). Manual tests run on the Test server before each release.

## 1. Automated tests (run with `npm test`)

| Suite | Where | What it proves | Count (Phase 3) |
|---|---|---|---|
| Shared rules | `packages/shared/src/*.test.ts` | Reference number format, password rule, role rules, input validation | 8 |
| API unit | `apps/api/src/**/*.spec.ts` | TOTP against the RFC 4226/6238 test vectors; encryption round-trips and tamper detection; audit hash chain; PDF safety check (scripts, attachments, non-PDF refused); field placement on rotated pages | 20 |
| API end-to-end | `apps/api/test/*.e2e-spec.ts` | Real PostgreSQL and Redis. Full journeys below. | 29 |
| Web | `apps/web/src/*.test.tsx` | Signed-out visitors are sent to sign-in; accessible controls | 2 |

### End-to-end journeys covered

**Sign-in and accounts**
- Same message for a wrong email and a wrong password (no account discovery)
- Administrators are forced to set up two-step sign-in, then to replace the seed password
- Replayed two-step codes are refused; each recovery code works once
- Refresh tokens rotate; re-using an old one ends the whole sign-in
- Lock-out after 5 wrong passwords; logout ends the session on the server
- Role checks: a sender cannot list users, change settings or read the activity log
- Disabling a user ends their sessions immediately; the last administrator cannot remove their own access

**Documents and signing**
- Refused uploads: plain text, PDF with JavaScript, wrong role, document type not allowed for e-signature
- Word upload is converted to PDF; original and PDF are both kept with different fingerprints
- Cannot send while a signer has no signature field; a sent document cannot be edited
- Sequential order: only step 1 is invited; step 2 is invited when step 1 finishes
- Staff signer signs from the dashboard (no emailed code); outside signer uses link + emailed code
- Consent is required before any field can be submitted; required fields are enforced; dropdown values must be one of the choices
- Signing twice is refused; a used link only says "already signed"
- Completion makes a signed PDF with an extra signing-record page whose text includes each signer, how they were verified, and the filled values
- Everyone (signers, copy recipients, sender) receives the signed copy as an attachment
- One-time codes: resend limited to once a minute, 5 wrong tries then the code dies, old codes stop working
- Decline stops signing for everyone and emails the sender the reason
- Cancel (void) by the sender stops all links; only the sender can cancel
- Access: other staff cannot see someone else's documents (404, not 403, so IDs reveal nothing); signers and auditors can; administrators cannot read documents
- Saved signatures are offered only inside a signed-in staff session
- The audit chain is intact after all of the above; editing a row with the trigger switched off is detected

**Approvals, templates, reminders, reports (Phases 2 and 3, `workflow.e2e-spec.ts`)**
- A supply contract cannot be sent while a step of its approval chain has nobody assigned; the sender sees which post is missing
- Procurement Manager, then Finance Director; the Managing Director is added only above the threshold
- Not your turn: the next approver and the sender cannot approve; nobody can approve twice
- No reference number and no signer email until the last approval; then the number is given and the first signer invited
- Return for changes: back to draft, approvers removed, sender emailed the reason; a missing contract value is caught when the chain depends on it
- Internal forms skip approval
- Templates: saved with role names, visible only to the right department, a new draft is created with people filled in, and it can be sent
- Reminders go only when due; documents past their deadline expire and the sender is told
- Notifications appear in the bell and can be marked read
- Reports and the retention review are for administrators and auditors only; CSV export; deleting files before the retention period ends is refused
- The nightly audit anchor runs and the chain stays intact

**Digital seal and checking (`signing.e2e-spec.ts`)**
- The completed copy and the certificate of completion are both stored and sealed
- `pdfsig` (poppler) reports the seal as valid, signed by "Ruliba Clays Ltd - Document Seal"; changing one byte makes it invalid
- The public check recognises the sealed copy (title, signers) and says "no match" for any other PDF; the authority certificate can be downloaded
- Manual check done on 2 Nov 2026: after importing the authority certificate into an NSS trust store, `pdfsig` reports "Certificate is Trusted"

**Reference numbers**
- 25 numbers requested at the same moment are unique and gap-free; a rolled-back approval does not use a number; numbering restarts each year

## 2. Security tests

| Test | How | When |
|---|---|---|
| Dependency vulnerabilities | `npm audit --omit=dev --audit-level=high` in CI (currently 0 findings) | Every change |
| Container vulnerabilities | Trivy scan of the API image in CI | Every change |
| Automated web scan | OWASP ZAP baseline scan against the Test server | Before each release |
| Manual checks | List in section 4 | Before the pilot |
| External penetration test | Independent tester, scoped to the internet-facing signing pages, the public check page and sign-in | Before go-live (not yet done) |

## 3. User acceptance test (Procurement, on the Test server)

Each tester works through these on a laptop and on their own phone, then ticks pass or fail with a comment.

| # | As | Do this | Expect |
|---|---|---|---|
| U1 | Procurement officer | Sign in for the first time with the temporary password | Asked to choose a new password, then the dashboard |
| U2 | Procurement officer | Upload a real supply contract (PDF) | Opens on the Signers step within 10 seconds |
| U3 | Procurement officer | Upload the same contract as a Word file | Fields can be placed on the converted PDF; layout looks like the Word file |
| U4 | Procurement officer | Add yourself and a test "supplier" email, one after another; place signature, date, name, a text and a dropdown | Fields go where you click and can be moved and resized |
| U5 | Procurement officer | Enter supplier and value; check the approval box; Send for approval | Status "Awaiting approval"; no reference number yet; Procurement Manager emailed |
| U5a | Procurement Manager, then Finance Director | Review and approve (one adds a comment) | Next approver emailed; after the last one: reference RCL/PRO/CON/…, status "In progress", signers invited |
| U5b | Procurement Manager | On a second contract, Return for changes with a reason | Sender gets the reason; document back in Drafts |
| U5c | Procurement officer | Send a contract above the Managing Director amount | The approval box lists three approvers |
| U6 | Procurement officer | Sign from the dashboard | Consent, then fields, then "Thank you" |
| U7 | Supplier (test mailbox, on a phone) | Open the email link, ask for a code, sign by drawing with a finger | Code arrives within 1 minute; drawing is smooth; "Thank you" |
| U8 | Everyone | Open the completed email | Signed PDF attached; fields and signatures where they were placed; signing record page at the end; Adobe Reader shows the Ruliba seal (trusted on Ruliba PCs with the authority certificate) |
| U8a | Anyone, signed out | Upload the signed PDF at /check; then upload a re-saved copy | "Genuine" with the right title and signers; then "No match" |
| U8b | Procurement officer | Save a contract as a template; create a new draft from it | Fields and order kept; only names and emails to fill in |
| U9 | Supplier | Open the same link again | "Already signed" |
| U10 | Procurement officer | Send a second document; supplier declines with a reason | You get an email with the reason; status "Declined" |
| U11 | Procurement officer | Send a third document, then cancel it | Supplier's link says "Cancelled" |
| U12 | Finance Director | Look for the Procurement officer's draft | Not visible |
| U13 | Auditor | Open any completed document and the activity log, run "Check the log now" | Read-only; "Intact" |
| U14 | Administrator | Reports for this month; export CSV | Figures match the documents sent in the test; CSV opens in Excel |

**Pass criteria for the pilot:** all of U1–U14 pass; no tester needed help for more than one step; every signed PDF opens in Adobe Reader and in a phone's PDF viewer.

## 4. Manual security checklist (before the pilot)

- [ ] HTTPS only; `http://` redirects; certificate valid; HSTS header present
- [ ] Signing link tokens do not appear in the Caddy access log (`docker compose logs caddy | grep /sign/`)
- [ ] The API container cannot reach the internet (`docker compose exec api node -e "fetch('https://example.com').then(()=>console.log('OPEN'),()=>console.log('blocked'))"` prints `blocked`)
- [ ] A PDF with JavaScript and an EICAR test file are both refused on upload
- [ ] The app database user cannot `UPDATE audit_events` (see deployment guide, section 4)
- [ ] Backup restore test done and logged (deployment guide, section 7)
- [ ] SPF, DKIM and DMARC pass for invitation emails (check the headers of a received invitation)
- [ ] The consent text, the signing-record wording and the list of excluded document types have been approved by Ruliba's lawyer

## 5. Pilot plan (Procurement)

1. **Week 1:** UAT on the Test server with 3 Procurement staff and 1 Finance signer (section 3).
2. **Weeks 2–5:** live with Procurement on production, with 2–3 trusted suppliers, for supply contracts through the full approval chain. For the first two weeks also sign a paper copy of contracts above the Managing Director threshold, until the lawyer has confirmed the consent text and signing record.
3. **Measure** (Reports page): documents sent and completed, typical time to complete, pages not printed; plus help requests, documents returned or declined because of mistakes, and maintainer hours.
4. **Review** with the Procurement Manager after week 5; fix issues; then extend to Finance and Administration.
