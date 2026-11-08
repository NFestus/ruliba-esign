# Training outline

Short, hands-on sessions on the **Test server** (never Production), with real-looking documents. Each participant uses their own test account. Bring a phone: one exercise signs as an outside supplier.

| Session | Who | Length | Group size |
|---|---|---|---|
| A. Sending and signing | Senders (Procurement first, then each department) | 90 min | up to 8 |
| B. Approving | Procurement Manager, Finance Director, Managing Director, department heads | 30 min | 1 to 4 |
| C. Signing only | Staff who sign but do not send | 20 min, or the user guide section 4 | any |
| D. Administration | IT office, eSign owner and backup | 2 hours | 2 to 4 |
| E. Audit and evidence | Internal audit, Finance, Legal | 45 min | 1 to 4 |

Before each session the trainer: creates test accounts, prints the one-page note for suppliers, prepares a 2-page sample contract PDF and a Word version, and sets up a supply-contract approval chain with the participants as approvers.

## A. Sending and signing (90 min)

| Time | Topic | Exercise |
|---|---|---|
| 0:00 | Why: less paper, faster turnaround, a record nobody can alter. What may not be signed electronically | Name two documents in your work that must stay on paper |
| 0:10 | Sign in, choose a password, turn on two-step sign-in. The dashboard and the bell | Everyone signs in and sets up two-step sign-in |
| 0:20 | Upload, document type, title | Upload the sample contract |
| 0:30 | Signers: order, "Gets a copy", suggestions | Add a colleague then yourself (phone email) as supplier, one after another |
| 0:40 | Fields: place, move, resize, required, dropdown | Place signature, date, TIN text field, payment-terms dropdown |
| 0:50 | Send: contract value, approval preview, reminders, expiry, message | Send for approval |
| 0:55 | (Trainer approves as Procurement Manager and Finance Director) | Watch the bell and the status change |
| 1:00 | Signing as staff; signing as a supplier on the phone with the emailed code | Colleague signs from the dashboard; you sign on your phone |
| 1:10 | The signed and sealed copy, the certificate, the activity log; Check a document | Download the signed copy and check it on the check page; change one character and check again |
| 1:20 | When things go wrong: send link again, cancel, returned for changes, declined | Trainer returns one document; participants correct and resend |
| 1:25 | Templates | Save the contract as a template; create a new draft from it |
| 1:30 | End | Hand out the user guide |

**Done when** each participant has sent one document that was approved, signed by two people (one by phone) and completed, and has checked the signed copy.

## B. Approving (30 min)

1. What approval means here (an internal decision recorded in the log, not a signature on the document) and why the reference number comes at the last approval (5 min).
2. Email, bell, **Review** in the list (5 min).
3. Read the document and files, **Approve** with a comment; **Return for changes** with a reason (10 min, each participant does both).
4. What the sender and next approver see; where approvals appear on the signing record (5 min).
5. Turn on two-step sign-in (5 min).

## D. Administration (2 hours)

1. People: add, roles, temporary password handed over in person, reset password, reset two-step, disable on leaving (20 min).
2. Departments and document types: codes in reference numbers; "May be signed electronically" off for excluded documents; retention years (20 min).
3. Approval chains: posts, people, the Managing Director amount; what happens when someone changes job (20 min).
4. Digital seal: certificates, fingerprints, installing the authority certificate in Adobe Reader on one PC; group-policy plan for all PCs (15 min).
5. Activity log, "Check the log now", the nightly fingerprint email (10 min).
6. Reports, CSV export, retention review (10 min).
7. Server side, from the deployment guide: backups and a full restore test on the Test server, master key custody, updates and rollback, email (Graph secret renewal) (25 min).

**Done when** the owner and backup have each performed a restore test and installed the authority certificate on a PC.

## E. Audit and evidence (45 min)

1. What evidence is kept for each signature: identity check method, consent text version, time, IP, device, fingerprints before and after (10 min).
2. The signing record page and certificate of completion; the seal in the PDF reader's signature panel (10 min).
3. The activity log and how the hash chain proves nothing was altered; the nightly anchor email (10 min).
4. Producing evidence in a dispute: download the sealed copy, certificate and the document's activity, check the copy on the check page, export the log (10 min).
5. Limits: platform seal, not a licensed-CA certificate; documents excluded by law (5 min).

## Materials

- [user-guide.md](user-guide.md) (staff, plus the one-page supplier note at the end)
- [admin-guide.md](admin-guide.md)
- [deployment.md](deployment.md) (for session D, server part)
- Sample contract PDF and Word file, test accounts list, feedback form (3 questions: what was hard, what was missing, would you use it tomorrow)
