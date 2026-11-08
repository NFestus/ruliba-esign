# Administrator guide

For the people who run Ruliba Clays eSign day to day: the IT office and the eSign owner. Installing and updating the server is in [deployment.md](deployment.md); this guide covers everything done from the web app.

Everything below is under **Settings** unless it says otherwise. Every change you make is written to the activity log with your name, the time and your IP address.

## 1. Your own sign-in

Administrators and auditors must use an authenticator app (Microsoft Authenticator, Google Authenticator or similar).

- At first sign-in you scan a QR code, type the 6-digit code, and are shown **10 recovery codes**. Print them or store them in the password manager. Each works once, if your phone is lost.
- If an administrator loses both phone and recovery codes, another administrator resets their two-step sign-in (People, the person, **Reset two-step sign-in (lost phone)**). Keep at least **two administrators** for this reason; the system will not let the last administrator remove their own access.

## 2. People

**Settings → People → Add user.** Enter full name, work email, job title, department and roles. The account is created **waiting for activation** and the person receives an email with an activation link (it works once, for 72 hours by default: `ACTIVATION_TOKEN_TTL_HOURS`). The link opens a page where they choose their own password (at least 12 characters; a short sentence works well); the account then becomes active and they sign in. Administrators and Auditors set up two-step sign-in at that first sign-in. No password is ever emailed.

- **The link expired or the email was lost:** People, the person, **Resend activation email**. Earlier links stop working.
- An account waiting for activation cannot be switched on by hand: only the person can activate it. If you disable it and enable it again, it goes back to waiting for activation.

| Role | Can |
|---|---|
| Sender | Upload documents, prepare and send them, use and save templates, see their own documents |
| Approver | Approve or return documents of their department, and see that department's sent documents |
| Signer | Sign documents from the dashboard (anyone can be sent a document; this role marks staff who sign often) |
| Auditor (read-only) | See all documents, the activity log, reports and certificates; change nothing |
| Administrator | Manage people, departments, document types, approval chains; see reports. **Administrators cannot open documents** unless they also have another role that allows it |

Give people only the roles they need. Someone can hold several.

- **Someone leaves Ruliba:** People, the person, **Disable account**. Their sessions end at once. Documents they sent stay, and their name stays in the records. Do not delete people.
- **Senders can add colleagues as signers.** On a document's Signers step (Internal → Add a new colleague), a Sender can create an account with the **Signer role only**; it waits for activation like any new account and appears in People. To limit which email domains senders may use, set `INTERNAL_EMAIL_DOMAINS` (e.g. `ruliba.com`) in the server settings.
- **Passwords cannot be reused:** a reset or change may not go back to any of the person's last 5 passwords.
- **Someone forgets their password:** they click **Forgot your password?** on the sign-in page and get an emailed link (works once, for 60 minutes: `PASSWORD_RESET_TTL_MINUTES`). Two-step sign-in still applies afterwards.
- **You need to reset someone's password** (for example, you suspect it is known to others): People, the person, **Reset password (emails a link)**. Their old password stops working at once, all their sessions end, and they get the link by email. No password passes through you.
- **Two-step sign-in:** people choose an **authenticator app** (recommended) or **text messages (SMS)**. It is always required for Administrators and Auditors. For anyone else, tick **Require two-step sign-in** on the person: they are signed out and must set it up at their next sign-in. People can also turn it on themselves (Settings → Your account). To change phone or method: **Reset two-step sign-in (lost phone)**, then they set it up again.
- **Security recommendation:** require two-step sign-in for Senders and Approvers too. A Sender's password alone can send a contract in Ruliba's name; the signing record says whether two-step sign-in was used.

## 3. Departments

**Settings → Departments.** The code (2 to 5 capital letters, e.g. `PRO`) appears in every reference number (`RCL/PRO/CON/2026/0001`). It cannot change once a reference number has used it; you can still rename the department and switch it off.

## 4. Document types

**Settings → Document types.** For each type:

| Setting | What it does |
|---|---|
| Code | Third part of the reference number, e.g. `CON` for supply contract |
| Needs approval before sending | Sends it through the approval chain (section 5) before signers are emailed |
| May be signed electronically | Switch **off** for documents Rwandan law does not allow to be signed electronically. Uploads of that type are refused with a message telling the sender to use paper |
| Keep signed copies for (years) | Retention period; drives the retention review (section 9). Leave empty until Ruliba's retention policy sets it |

**Documents that must stay on paper.** Law 18/2010 on electronic messages, signatures and transactions excludes, among others: wills, negotiable instruments (cheques, bills of exchange), **powers of attorney**, documents relating to **land and buildings** (immovable property and transfers of it), and authentic (notarised) deeds. Create a type for each of these that staff might try to send, with "May be signed electronically" switched off. "Power of attorney" is set up this way already. Have Ruliba's lawyer confirm the list.

## 5. Approval chains

**Settings → Approvals.**

1. **Currency for approval amounts:** set once (RWF). Senders enter the contract value in this currency.
2. **Chains.** Only supply contracts have a chain at the start. Every other type with "Needs approval before sending" switched on (Purchase order, Agreement, NDA) needs one: click **New approval chain**, name it, choose the document type (or "Every type that needs approval") and optionally a department. A yellow notice on this page lists any type that still has no chain; senders cannot send those. Each chain applies to a document type (and optionally one department). The most specific chain wins: type + department, then type for any department, then a chain for all types.
3. For each step, choose the post (e.g. Procurement Manager) and the **person holding it**. Steps run in order.
4. **Only above an amount:** fill this in for a step that applies only to larger contracts. The agreed chain for supply contracts is:

| Step | Post | Only above |
|---|---|---|
| 1 | Procurement Manager | |
| 2 | Finance Director | |
| 3 | Managing Director | the amount the board sets (enter it here) |

When someone changes post, edit the chain and pick the new person. Documents already waiting keep the approver they were sent to; to move one, the sender cancels it and sends again.

What approvers see: an email and a bell notification, then **Review** in their list. They read the document and choose **Approve** (with an optional comment) or **Return for changes** (with a reason, emailed to the sender). The reference number is given when the last approver approves; then the signers are emailed.

If a step has nobody assigned, senders see "No one is assigned as …" and cannot send. That is deliberate.

## 5a. Company stamps

**Settings → Stamps → Add a stamp.** Give it a name (e.g. "Ruliba Clays official stamp"), choose a scan or photo of the stamp on white paper (the white is made transparent), and tick the people who may apply it. Only those people see the stamp when a document has a Stamp box for them; nobody else can apply it, and outside signers can never use a Ruliba stamp (they upload their own company stamp instead).

- A copy of the stamp image goes with each stamped document, and the signing record names the stamp and its fingerprint. Changing or withdrawing a stamp later never changes documents already stamped.
- To change who may use a stamp: **Edit**. To stop it being used: **Withdraw** (**Use again** restores it). To change the picture, withdraw the old stamp and add a new one, so the record shows which picture was used when.
- Treat stamp access like the physical stamp: give it only to people who hold the real one today.

## 6. Digital seal and certificates

**Settings → Digital seal.** The first time a document completes, the system creates:

- **Ruliba Clays eSign Authority** (valid 10 years), which issues
- **Ruliba Clays Ltd - Document Seal** (valid 3 years), which seals every completed document and certificate of completion.

Private keys are encrypted with the master key and never leave the server. The page shows each certificate's fingerprint; write the authority's fingerprint into the IT records.

**Make Ruliba's computers trust the seal** (once per computer, or by group policy):

1. Download the authority certificate from this page.
2. Adobe Reader: Edit → Preferences → Signatures → Identities & Trusted Certificates → More → Trusted Certificates → Import. Choose the file, select it, **Edit Trust**, tick **Use this certificate as a trusted root**, OK.
3. Open any signed copy: the signature panel shows "Signed by Ruliba Clays Ltd - Document Seal", valid and trusted.

Outside Ruliba, the seal shows as valid but from an issuer that is not trusted. That is expected. Tell partners to use the public check page (section 8) or install the certificate.

When the seal certificate expires (after 3 years), a new one is made automatically by the next completed document. Documents sealed earlier still show that they have not been changed, and the check page still recognises them, but some PDF readers will then say the seal certificate has expired, because the seal carries no time-stamp from an independent time-stamping service. Adding such a service is listed as a later improvement in the handover document. When the authority itself expires (after 10 years), a new authority is made, and its certificate must be installed on Ruliba computers again. Put both dates in the IT calendar.

**Limit to be aware of:** this is Ruliba's own seal, not a certificate from a licensed Rwandan certification authority. It proves a file came from eSign unchanged; it does not make a signature "secure" in the Law 18/2010 sense. When RISA's national PKI issues certificates to companies, it can be added as a higher signature level.

## 7. Activity log

**Settings → Activity log** (administrators and auditors). Every sign-in, failed sign-in, setting change and step of every document, with time, person and IP address.

**Is the log intact?** → **Check the log now** re-computes the chain of fingerprints over every entry. It also runs every night at 02:15; if `AUDIT_ANCHOR_EMAIL` is set, that night's fingerprint is emailed to an independent mailbox (for example the Finance Director's). If anyone ever rewrites the database, the chain breaks, or the emailed fingerprints no longer match. A broken chain means: stop, keep the server as it is, and call the eSign owner.

## 8. Checking a document (anyone)

`https://esign.ruliba.com/check` is public, no sign-in. A supplier, bank, auditor or court uploads a PDF and learns whether it is exactly a copy signed through eSign, with the title, reference, signers and dates. The file is only fingerprinted, not stored. Staff find the same page under **Check a document** in the menu.

A copy that has been printed and scanned, re-saved, or "printed to PDF" will not match: that is the point.

## 9. Reports and retention

**Reports** (menu; administrators and auditors):

- Documents sent, completed, still open, declined/cancelled/expired; typical time to complete; pages not printed. Choose the period at the top.
- By department, by document type, by month.
- **Export list (CSV)** opens in Excel. Each export is logged.

**Retention review** (bottom of Reports) lists completed documents older than the "keep for" period of their type. **Nothing is deleted automatically.** An administrator can **Delete files** with a reason (e.g. the retention decision reference): the PDFs are deleted for good; the record, fingerprints and activity log remain, so it is still on record that the document was signed. Never delete files of a document under dispute or legal hold.

## 10. When something goes wrong

| Symptom | Check |
|---|---|
| Nobody receives emails | Worker running (`docker compose ps`), `EMAIL_TRANSPORT`, Graph secret not expired (12-month expiry), SPF/DKIM/DMARC |
| One supplier gets no email | Their spam folder; then on the document, **Send link again** (the old link stops working) |
| "This code was already used" / code not arriving | Codes last 10 minutes; one new code per minute, 5 an hour. Ask them to use the newest email |
| Upload refused "contains active content" | The PDF has scripts or attachments. Ask for a clean PDF, or print to PDF |
| Word upload fails | Gotenberg container running |
| Document stuck "In progress" although everyone signed | The worker finishes it within 5 minutes; if not, check the worker log |
| Someone is locked out | 15 minutes after 5 wrong passwords; or reset their password |
| Audit chain broken | Stop. Do not restore or repair. Call the eSign owner |

## 11. Regular tasks

| When | Task |
|---|---|
| When staff join, move or leave | People, approval chains |
| Monthly | Look at the activity log for repeated failed sign-ins; look at Reports |
| Quarterly | Backup restore test (deployment guide section 7) and record it |
| Yearly | Graph client secret renewal; dependency and security update; review document types and retention with the lawyer |
