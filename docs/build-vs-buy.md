# Build or buy: Ruliba Clays eSign compared with DocuSign and alternatives

Prepared 2 November 2026. Prices are list prices found on that date (sources at the end) and must be confirmed with each vendor before a decision. Exchange rate used: **1 USD = 1,480 RWF** (2 Nov 2026).

## 1. What Ruliba needs (the yardstick)

| Need | From the brief |
|---|---|
| Senders | About 25 staff prepare and send documents |
| Volume | 70 to 100 documents a month (about 1,000 a year), growing as paper is phased out |
| Signers | Staff, plus suppliers and partners with **no account**, by email link and one-time code |
| Approvals | Supply contract → Procurement Manager → Finance Director, plus Managing Director above a threshold; reference number at final approval |
| Data | Hosted in Rwanda, nightly encrypted copy in Ruliba's server room (Law 058/2021 on personal data) |
| Evidence | Defensible audit trail, consent, retention per document type, verification by third parties |
| Email | From sign@ruliba.com (Microsoft 365) |

## 2. The options

| | Ruliba eSign (built) | DocuSign eSignature | Adobe Acrobat Sign | Zoho Sign | Local provider (e.g. Dusinye) |
|---|---|---|---|---|---|
| Where data lives | Rwandan data centre + Ruliba server room | US/EU/other DocuSign regions; no Rwanda region | Adobe regions (US/EU/others); no Rwanda region | Zoho regions (India/US/EU/others); no Rwanda region | Ask; may be Rwandan |
| Who pays per seat | Nobody: unlimited staff and signers | Every sender | Every sender | Every sender | Ask |
| Outside signers need an account | No | No | No | No | Ask |
| Ruliba's approval chain with value threshold and numbering at approval | Built exactly as agreed | Partly: conditional routing on Business Pro; no Ruliba reference numbering | Partly, through workflows | Partly | Ask |
| Reference numbers RCL/DEPT/TYPE/YEAR/NNNN | Yes, gap-free | No (envelope IDs) | No | No | Ask |
| Signature evidence | Audit log, signing record page, certificate of completion, Ruliba digital seal, public check page | Certificate of completion, DocuSign digital seal (widely trusted by PDF readers) | Audit report, Adobe seal (trusted by Adobe Reader) | Completion certificate, seal | Ask |
| Trusted seal out of the box in Adobe Reader | **No**: Ruliba's own authority must be installed (see section 6) | Yes | Yes | Yes | Ask |
| Licensed certification authority (Law 18/2010 "secure" signature) | No; GovCA certificate can be added later | No (standard plans) | No (standard plans) | No (standard plans) | Ask |
| Support | Ruliba maintainer + backup | Vendor, 24/7 on higher plans | Vendor | Vendor | Local |
| Exit | Own the code and data | Export per envelope; history stays with vendor | Same | Same | Ask |

I could not find published pricing or technical documentation for Dusinye eSign or another Rwanda-based e-signature service. Treat that column as a list of questions for a quote, not as facts.

## 3. Three-year cost of ownership (USD)

### Bought services: 25 sender seats

List prices per seat per month (section 9). External signers cost nothing extra on these plans. Add-ons such as SMS codes or ID checks are extra and not included.

| Option | Per seat per month | Year 1 | Year 2 | Year 3 | **3 years** | **3 years (RWF)** |
|---|---|---|---|---|---|---|
| DocuSign Business Pro (closest fit: bulk send, conditional routing) | $45 | 13,500 | 13,500 | 13,500 | **40,500** | 59.9 million |
| DocuSign Standard (no approval routing) | $30 | 9,000 | 9,000 | 9,000 | **27,000** | 40.0 million |
| Adobe Acrobat Pro for teams (includes Acrobat Sign) | $23.99 | 7,197 | 7,197 | 7,197 | **21,591** | 32.0 million |
| Zoho Sign Professional (annual billing) | $16 | 4,800 | 4,800 | 4,800 | **14,400** | 21.3 million |

DocuSign's Standard and Business Pro plans cap envelopes at about 100 per seat per year. 25 seats give 2,500 a year, enough for Ruliba's 1,000.

Also budget for a bought service: setting up templates and training (the same as for the built system), and **time to move to another vendor later**, because the history does not come with you.

### Ruliba eSign (built and run by Ruliba)

The software itself is delivered. What remains is running it. The figures in *italics* are estimates for Ruliba to replace with real quotes and internal rates.

| Item | One-off | Per year | 3 years | Notes |
|---|---|---|---|---|
| Lawyer review of consent text, signing record and excluded documents | *2,000* | | 2,000 | Before the pilot; required |
| External penetration test | *5,000* | | 5,000 | Before going live; re-test after major changes |
| Rwandan cloud server (4 vCPU, 8–16 GB RAM, 200 GB disk, backups) | | *2,400* | 7,200 | Get quotes from local data centres |
| Backup disk for the server room | *300* | | 300 | Existing server room |
| Maintainer time (owner + backup), about 3 days a month | | *3,600* | 10,800 | Updates, user support, restore tests; at an assumed internal cost of $100 a day |
| Yearly security review and dependency updates | | *1,500* (years 2–3) | 3,000 | Can be the same firm as the penetration test |
| Email | | 0 | 0 | Uses the Microsoft 365 tenant Ruliba already has |
| GovCA certificate (optional, when available to companies) | | *TBD* | TBD | Only if documents need a licensed-CA signature |
| **Total** | **7,300** | | **28,300** | 41.9 million RWF |

### What the numbers say

- **Ruliba eSign costs about the same as DocuSign Standard over three years, less than DocuSign Business Pro, and more than Zoho Sign or Adobe.** On price alone, a cheap SaaS plan wins.
- **Ruliba eSign gets cheaper per document as use grows.** Seats do not matter: adding 50 more senders, or every department, costs nothing extra. With a bought service, every new sender is another seat.
- Most of the built option's cost is **one-off assurance (legal review, penetration test) and staff time**. A bought service still needs the legal review, because the consent wording and the list of excluded documents are Ruliba's responsibility either way.

## 4. Where the built system is better

1. **Data stays in Rwanda.** No bought option has a Rwandan region. Under Law 058/2021, sending personal data abroad needs a legal basis and, in some cases, registration with or authorisation from the supervisory authority (NCSA); confirm the details with the lawyer. Keeping it local removes that question for contracts that name staff and suppliers.
2. **It follows Ruliba's process**, not the other way round: the agreed approval chain with the Managing Director above a value threshold, reference numbers given at final approval, department scoping, documents that may not be signed electronically refused at upload.
3. **No per-seat limit on going paperless.** The aim is to remove paper across the company; seat pricing works against that.
4. **Ruliba owns the evidence.** The audit log, signing records and files are in Ruliba's database and backups, kept as long as Ruliba's retention rules say, and can be produced in a dispute without depending on a vendor account staying active.
5. **Exit cost is zero.** The code, data and keys belong to Ruliba.

## 5. Where a bought service is better

1. **Trusted seal in every PDF reader.** DocuSign's and Adobe's seals show as trusted everywhere. Ruliba's seal shows as valid but "issuer not trusted" until a reader adds the Ruliba authority certificate. For outside parties, the public "Check a document" page is the answer; inside Ruliba, IT installs the certificate once.
2. **No maintenance burden.** Security patches, uptime and backups are the vendor's job. With the built system, if the maintainer leaves, Ruliba must replace that knowledge (see the handover document).
3. **Vendor support and certifications** (ISO 27001, SOC 2), which some counterparties ask about.
4. **Mature extras**: mobile apps, integrations, ID verification, payments.

## 6. Risks of the built option, and how they are handled

| Risk | Handling |
|---|---|
| Key person leaves | Named owner and backup; handover document; standard stack (TypeScript, PostgreSQL, Docker); 49 automated tests |
| Security flaw | OWASP controls, penetration test before go-live, `npm audit` and image scans in CI, yearly review |
| Loss of the master key | Two encrypted USB keys in separate places (deployment guide section 5); quarterly restore test |
| Seal not trusted outside Ruliba | Public check page; signing record and audit trail as evidence; GovCA certificate when available |
| Hardware or data-centre failure | Nightly encrypted backup in the server room; restore test each quarter |

## 7. Recommendation

**Go live with Ruliba eSign, pilot it with Procurement, and review after six months.**

The three-year cost is in the same range as the mid-market bought services, and it is the only option that keeps contract data in Rwanda, follows the agreed approval chain and reference numbering, and lets every department go paperless without buying more seats. Its main weakness (a seal that readers do not trust by default) is covered by the check page and by installing the authority certificate on Ruliba computers.

**Choose a bought service instead if** Ruliba cannot commit a maintainer and a backup for at least two to three days a month, or if counterparties insist on a seal that Adobe Reader trusts without setup. In that case, Zoho Sign or Adobe are the lower-cost choices, DocuSign the best-known; check first whether a Rwanda-hosted local provider can meet the requirements in section 1.

**At the six-month review, measure:** documents completed, typical time to complete (Reports page), pages not printed, sign-in or signing problems reported, and maintainer hours actually spent. If maintainer time is far above the estimate, revisit this comparison.

## 8. Questions to ask any vendor (including a local provider)

1. Where are documents, audit logs and backups stored? Can it be Rwanda only?
2. Price per sender, and is there a limit on documents a year? Are outside signers free?
3. Can it do: approval before sending, a value threshold that adds an approver, our own reference numbers?
4. How are outside signers verified (email code, SMS)? Is SMS extra, and does it work with Rwandan networks?
5. What does the completion certificate contain? Is the PDF sealed, and by which certificate?
6. Can we export all documents and audit trails if we leave, in what format?
7. Security certifications (ISO 27001, SOC 2) and a recent penetration test summary.
8. Support hours in Kigali time; who to call when signing is blocked.

## 9. Sources

- DocuSign plan prices and envelope limits: [Automation Atlas, DocuSign pricing 2026](https://automationatlas.io/answers/docusign-pricing-explained-2026/)
- Adobe Acrobat (Sign) team plan prices: [Costbench, Adobe Sign plans](https://www.costbench.com/software/e-signature/adobe-sign/) (marked unverified by the site)
- Zoho Sign plan prices: [Costbench, Zoho Sign pricing](https://costbench.com/software/e-signature/zoho-sign/) (the site itself shows inconsistent figures; confirm with Zoho)
- Rwandan e-signature law summary (Law 18/2010, excluded documents): [BoldSign, legality of e-signatures in Rwanda](https://boldsign.com/electronic-signature-legality/rwanda/)
- Rwanda national PKI upgrade by RISA (2026 tender): [AllBusiness Africa tender notice](https://allbusiness.africa/tenders/risa-rdap-national-pki-upgrade-2026)
- Exchange rate: [Trading Economics, USD/RWF](https://tradingeconomics.com/rwanda/currency)
