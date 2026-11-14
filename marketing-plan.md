# Spine: Marketing Plan
 
Snapshot of the living document, taken 9 Nov 2026 (rev 13). The source of truth is the editable doc: https://claude.ai/code/artifact/c613f7bd-2fe9-4fd0-91f3-4ed567d02e51. Spine is the medical-history app (public B2C launch planned for the week of 9 Nov 2026, no beta, sold through Paddle as merchant of record). The functional and technical requirements live in a separate doc: https://claude.ai/code/artifact/0557f344-3739-4609-84f4-fcf5a41a7fa8
 
Updated in this snapshot on 14 Nov 2026: plans and prices settled (Free, Esențial, Premium, Family, Founding member, add-ons, VAT included), competitors, first Reddit post, and day-one metrics with an internal dashboard. None of this is in the live doc yet.
 
Reviewed on 14 Nov 2026 (evening): the Review section below records what was decided (focus segment, IP and trademark on the company, visible trial limits, Esențial at €2.49 / €24.90, Founding without deadline, emails, invitation bonus) and what is still open.
 
## Goal
 
Get enough active users that shared links and emergency cards bring in new users without manual effort. Target figures are open until launch data exists.
 
| Metric | Target |
| --- | --- |
| Waitlist signups before launch | (open) |
| Active users at month 3 | (open) |
| Share links opened per active user per month | (open) |
| New signups arriving from a share link or QR | (open) |
| Paid conversion | (open) |
 
Provisional targets for the first 30 days (agreed 14 Nov 2026): 300 accounts, 40% with the import done, 25 Founding member sales.
 
## Review, 14 Nov 2026
 
### Decided
 
- **Focus segment for the first 90 days:** Romanians in the diaspora (Italy, Spain, Germany, the UK) with a thick medical history or who keep the family's records. Translation for a doctor abroad is the differentiator. The technical communities (HN, r/selfhosted, r/privacy) bring credibility and code review, not revenue.
- **IP and trademark stay with OMNI EDGE SRL.** Alex wrote Spine as an employee of the company (programmer's assistant), so under Law 8/1996 the economic rights in the software belong to the employer unless the contract says otherwise. LICENSE keeps the company as holder; the repository stays as it is. Worth checking once: the job description covers software development, the employment contract has no clause leaving the rights with the employee, and all the code was written while employed. If any part predates the employment, a one-page assignment (cesiune) for that part; optionally a one-page statement confirming Spine was developed as part of the job.
- **Trademark:** file at OSIM now, in the company's name, to fix the filing date. Apply in parallel for the EUIPO SME Fund voucher (75% of fees up to €700, applications until 4 Dec 2026, voucher approved before the filing it pays for, valid one month with one extension) and use it for the EUIPO extension, within the 6-month priority period.
- **Launch this weekend:** deploy and make the app public. The posts (Show HN, Product Hunt, diaspora) follow over the next weeks.
- **Trial limits, visible to the user, totals for the whole trial:** 150 pages (unchanged), 50 questions, 30 translated pages. Duration stays 6 months. The counter is shown from day one. At a limit the archive stays visible and exportable and the offer is Founding member or a paid plan. This replaces the Premium hidden ceilings during the trial and brings the maximum cost of a trial account from €60-70 down to about €4-5. The principle "only adding is limited, never use" now applies to paid plans only, and becomes the reason to pay.
- **Esențial price:** €2.49 a month or €24.90 a year (was €1.99 / €19).
- **Founding member:** stays €39 a year for the first 500, no deadline and no bonus pages. With visible trial limits, the reason to buy on day one is that Founding removes them.
- **Downgrade after the trial:** the archive stays fully visible and exportable; only adding stops (and the paid-only features).
- **VAT:** calculate with a 21% average (Romania 21%, Italy 22%, Spain 21%, Germany 19%). The tables below still use 20%; recompute them in the sheet.
- **Automatic emails (Brevo), no medical content:** welcome with the first step; a periodic reminder ("had an appointment? add the documents"); two weeks before the trial ends, with the plan that fits.
- **Invitation bonus:** when an invited person creates an account, both sides get 10 extra pages, once per invitation, at most 5 invitations per account (about €0.25 per person).
- **Message:** "zero-knowledge storage; AI processing passes through a relay that keeps nothing; the code is public", said first, before others point it out. Confidential Space goes on the roadmap as the step that makes the claim verifiable. A security page (threat model, who is behind Spine, EU company, public code) and a short page for doctors, linked from the share-link viewer footer.
- **Pricing page:** three columns (Free, Esențial, Premium), Family on a row below; add-ons shown only in the app, at the moment of need. A written refund policy (14-day withdrawal right, the rule for annual plans).
- **Cost control:** a monthly AI budget alert from day one.
- **Selling on the web only** until Apple's commission is in the sheet (EU, from 1 Oct 2026: 15% through an external link, 26% through In-App Purchase; 10% and 15% in the reduced-rate programmes).
- **Provisional targets for the first 30 days:** 300 accounts, 40% with the import done, 25 Founding member sales.
- **Weekly indicators for the marketing role:** posts approved and published, partner conversations, accounts from the diaspora.
### To verify before building
 
- Whether the server can know that an import is finished or what an account holds. The archive is sealed, so the "import not finished" email and the monthly summary email depend on app-reported counters; they are not decided. The same question applies if the invitation bonus should wait for the invitee's import rather than account creation.
- Paddle: the prices under $10 (€2.49, €4.99, €8.99). Alex will raise it with them.
### Trademark filing
 
- Free search first for earlier marks (TMview, OSIM database), classes 9 and 42. "Spine" is a common word and earlier software marks are likely; "SpineVault" would pass more easily. Fees are not refunded if the application is refused.
- Word mark (the word SPINE alone, protects the name in any lettering). The logo is a separate figurative filing, optional.
- Classes: 9 (software applications), 42 (software as a service), possibly 44 (medical information services).
- Cost: OSIM 51 lei for the application plus 152 lei for black-and-white publication, plus the examination fee per class within 30 days (exact amount from the OSIM fee calculator). EUIPO: €850 base fee for one class (second class about €50, to confirm in the EUIPO calculator).
- Protection lasts 10 years from filing, renewable. The trademark does not block the launch; the real risk is an earlier mark in the same classes, which the search shows.
### Still open
 
- 10 conversations with people from the focus segment in the first two weeks.
- Basic assets: a 60-90 second demo (a Romanian report translated into Italian), start pages in Romanian, Italian, Spanish and German.
- 5-10 diaspora partners followed weekly (associations, Romanian doctors abroad, clinics with foreign patients); Facebook groups need the admins' agreement.
- Few SEO pages, checked by hand; batches of generated medical content are risky and take 3-6 months to show results.
- Costs missing from the plan: legal documents (terms, privacy policy, DPIA) reviewed by a lawyer, own estimate €500-1,500; a security audit, a few thousand euros, without which a Privacy Guides listing is unlikely; developer accounts (Apple $99 a year, Google $25 once).
- The marketing role's revenue share needs a defined base (net revenue after VAT, Paddle and AI) and a contract.
- Spine revenue adds to consulting revenue towards the micro-enterprise ceiling: check the distance with Keez.
### Before taking payments
 
- CAEN 5829: the ONRC application is filed (Alex, 14 Nov 2026).
- Paddle: account approved, domain verified, prices under $10 confirmed, terms, privacy and refund pages published.
- GDPR: health data (art. 9), explicit consent, DPIA done before launch, processing agreement with Google, notice that answers are AI-generated.
- Wording: no unqualified "zero-knowledge", no "unlimited", translation not certified, no medical advice or diagnosis.
## Built-in growth loops
 
The product does the selling once people use it; these loops need no ongoing effort.
 
| Loop | Who sees it | Mechanism |
| --- | --- | --- |
| Doctor share link | Doctors, often abroad | "Shared securely via Spine" footer on the viewer, with a link for doctors to recommend it to patients |
| Emergency QR card | Paramedics, ER staff, anyone shown the card | Card viewer explains what Spine is, in the viewer's language |
| Family invites | Partners, co-parents, adult children | Inviting a co-guardian or delegating a parent's profile creates a new account |
| Promotion at 18 | The new adult | Keeps the account and history; becomes a user in their own right |
| Translated record | Patient and doctor | Translation in the doctor's language is the moment that makes Spine memorable |
 
## Launch
 
Done by hand, once, because privacy and patient communities reject automated posting. The app is deployed and made public the weekend of 14 Nov 2026; the posts below follow over the next weeks.
 
- [ ] Show HN post on Hacker News: the open-source, zero-knowledge angle and the story of building it for yourself
- [ ] r/selfhosted post with the Docker Compose self-host
- [ ] r/privacy and r/degoogle posts
- [ ] Product Hunt launch
- [ ] Listing on Privacy Guides (submit for review)
- [ ] Listing on AlternativeTo, next to Fasten and Apple Health
- [ ] Pull request to the awesome-selfhosted list on GitHub
- [ ] Posts in Romanian diaspora groups in Italy, Spain, the UK and Germany
### First Reddit post (researched 14 Nov 2026)
 
Subreddit rules change often, and several findings below come from mirrors or secondary sources. Check each subreddit's rules page on launch day.
 
| Order | Subreddit | What the research found | Action |
| --- | --- | --- | --- |
| 1 | r/selfhosted | Since Q2 2026, new projects (under three months old) go in the weekly New Project Megathread, a new one each Friday, and standalone new-project posts are removed. The template asks for AI involvement, to be answered transparently. Open source is preferred and pricing must be upfront. Fasten, a comparable self-hosted medical records app, launched here repeatedly | Top-level comment in the current megathread: Docker Compose self-host, zero-knowledge model, paid hosted tier stated upfront, honest AI-involvement line. Can be posted any day of the week |
| 2 | r/SideProject | Built for founders to share what they are building | Same weekend, a different angle (the story of building it for yourself) |
| 3 | r/privacy | Developers may post only open-source, non-commercial privacy software, after agreeing expectations with the mods (2023 rule text, may have changed). The paid hosted tier may not fit | Modmail first; not the first post |
| 4 | r/opensource | Reported (weakly sourced) to require a year of maintenance, several contributors and an existing community, and to exclude AI projects | Skip for launch |
| 5 | r/PrivacyGuides | Restricted subreddit; self-promotion only through the forum's Project Showcase, with a verified developer role | Apply for verification on the forum |
| 6 | r/degoogle | Rules not verified; weak fit, since Spine does not replace a Google product | Skip the first round |
| 7 | Patient communities (r/ChronicIllness, about 110K members) | Support communities; promotion rules not verified | Take part and answer questions; modmail before any post |
 
## Further channels for the initial mass
 
The fastest route to the first users is groups that already feel the cross-border records problem; partners and press come second. For the first 90 days the diaspora channels come first (decided 14 Nov 2026); the others wait or run at minimum effort.
 
| Channel | Audience | How | Effort |
| --- | --- | --- | --- |
| Patient communities (chronic illness, rare disease, endometriosis, diabetes) | People with thick medical histories | Subreddits, Facebook groups, forums; answer questions, mention Spine where relevant | Ongoing, low |
| Expat and digital nomad communities | People seeing doctors abroad | Expat Facebook groups per city, r/expats, Nomad List, InterNations | Ongoing, low |
| Erasmus and international students | Students moving across the EU | University international offices, Erasmus Student Network chapters | One-off outreach |
| Diaspora media and associations | Romanians abroad | Diaspora news sites, Romanian associations and parishes abroad | Weekly follow-up with 5-10 partners (was one-off pitches) |
| Caregivers of elderly parents | Adults managing a parent's care | Caregiver forums; the family plan is the hook | Ongoing, low |
| Parents | Families with children's records | Parenting groups; vaccination and paediatric history as the hook | Ongoing, low |
| Privacy press and podcasts | Privacy-minded early adopters | Pitch It's FOSS, privacy newsletters, self-hosting podcasts | One-off pitches |
| Romanian tech press | Romanian early adopters | Pitch Start-Up.ro, Wall-Street.ro tech section, Romanian tech podcasts | One-off pitches |
| YouTube and TikTok short demos | Broad consumers | Short clips: a Romanian report translated live into Italian; the spine timeline | Automatable after the first few |
| LinkedIn (your own profile) | Professional network, doctors | Build-in-public posts about the architecture and privacy model | 1 post a week |
| Travel insurers and relocation services | Expats and travellers | Partnership: Spine as an add-on for policyholders | Later, once there are users |
| Clinics treating foreign patients | Medical tourists, expats | Clinics recommend Spine to patients; no integration needed | Later |
| Open-source grants (NLnet, Prototype Fund) | Credibility and funding | Applications also bring visibility in the FOSS community | One-off |
 
## Automation pipeline
 
AI drafts everything repeatable; nothing goes to a community or a person without approval.
 
| Workstream | Runs headless | Needs approval |
| --- | --- | --- |
| SEO pages for country and language pairs ("Romanian medical records for a doctor in Italy") | Drafting, translation, publishing schedule | Spot-check a sample of each batch for medical or legal errors |
| Comparison pages (Fasten alternative, Apple Health records, encrypted medical records apps) | Drafting | Review before publishing |
| Changelog to social posts | Drafting from each release | Approve the queue |
| Short demo videos | Editing and captions from screen recordings | Approve before posting |
| Community monitoring | Finding threads that ask about records abroad or medical-record apps | Write the reply yourself |
| Support and feedback triage | Sorting, drafting replies, tagging feature requests | Send the reply |
| Press and partner outreach | Building lists, drafting pitches | Send personally |
 
Tools to decide: CMS for SEO pages, social scheduler, community-monitoring tool, video editor.
 
## Weekly time budget
 
About two to three hours a week after launch; launch week itself takes several evenings. Per-task estimates are still open: approving drafted posts, pages and videos; replying in community threads; support replies; one LinkedIn post; reviewing metrics.
 
## Competitors (researched 14 Nov 2026)
 
No competitor found combines open source, zero-knowledge, an EU company, a hosted service and AI translation for a doctor abroad. Open-source options are self-host only; AI and translation apps are closed; EU apps are free and publicly funded or simple organisers. Lead the pricing page with that combination.
 
| App | What it does | Open source | EU | Price a year |
| --- | --- | --- | --- | --- |
| Fasten Health | FHIR aggregator (US provider integrations), self-host | Yes, GPL-3.0 | No (US) | $50 one-off |
| YourPHR, MediKeep, Mediqux | Medical record viewers, self-host only | Yes | No | Free |
| Sync.MD | Upload, OCR, AI summaries, translation | No | No (US) | ~$60 ($4.99 a month) |
| Available Health | Organising, AI summaries, appointment prep | No | No (US) | $80 |
| mCharts | Records from Apple Health | No | No | $49.99 (Gold) |
| Health Data Avatar | Cross-border, multi-language records, translation, chat | No | Unclear | Not found |
| BodyWision | Personal record, AI coach | No | Yes (Austria) | Free download, paid tier unclear |
| Saluso | Lab results, sharing with doctors, AI translation | No | Yes (Portugal) | Premium, price not found |
| Andaman7 | Personal record, AI summary and translation | No | Yes (Belgium) | Free |
| MediRecord | Family organiser | No | Yes (Poland) | ~79.99 zł (~€19), family ~119.99 zł |
| MedMemoir, Tidy Health, Roojh | Simple organisers | No | No | $10-30 |
| Dutch PGO apps | GP record access via MedMij | Varies | Yes | Free |
 
Notes:
 
- Fasten is the open-source reference, but reported with no commits since 13 Feb 2026 and is built around US integrations.
- Health Data Avatar is the closest positioning (chronic patients, carers, people who moved countries); not open source; price and company country not found.
- Sync.MD is closest on AI features (OCR, smart search, translation into any language).
- Dutch PGO apps had just under 500,000 users last year despite public funding: adoption is hard even at zero price.
- Price band: €49 sits with the AI apps ($50-80), above simple organisers ($10-30). It holds only if AI and translation are clearly better than a folder in Google Drive.
- To check before fixing the price: Health Data Avatar, BodyWision and Saluso prices, directly on their sites or in the apps.
Sources: [Fasten (AlternativeTo)](https://alternativeto.net/software/fasten-health/about), [Fasten activity (selfhostyourself)](https://selfhostyourself.com/services/fasten-health), [Sync.MD](https://apps.apple.com/us/app/-/id1435733695), [Available Health](https://apps.apple.com/app/id6757343704), [mCharts](https://apps.apple.com/app/id1475914379), [Health Data Avatar](https://www.producthunt.com/p/self-promotion/as-a-patient-advocate-personal-health-data-management-is-the-biggest-barrier-for-care), [BodyWision](https://mwm.ai/ko/apps/bodywision/6775884131), [Saluso](https://apps.apple.com/app/id6761137543), [MediRecord](https://apps.apple.com/pl/app/medirecord/id1601630193), [Dutch PGO adoption (Computable)](https://computable.nl/?p=376041)
 
## Pricing and unit economics
 
Working model on Gemini 3.5 Flash. Plans and prices settled 14 Nov 2026, revised the same afternoon (Esențial with a monthly option, Family €89 / €8.99) and again in the evening (Esențial €2.49 / €24.90, visible trial limits) (replace the 11 Nov version at €39 / €3.99, which left VAT out). Document volumes and token counts are estimates; replace them with real figures from Vertex AI usage logs. Live calculations: the "Spine: rentabilitate salariu marketing" sheet, https://claude.ai/artifact/VHc65Cpwg6U5zvb1tUZF6A (tabs Planuri, Prețuri, Scenarii, Ipoteze).
 
### Principles
 
- Only what is added to the archive is limited, never what is done with it. Once a document is in, asking, translating and sharing are not capped on the paid plans that include them. The trial is the exception: it has visible totals for questions and translated pages (decided 14 Nov 2026).
- A page counts only when it stays in the archive after review. A failed extraction the user rejects and re-uploads costs them nothing.
- Unused pages roll over, up to three months' worth, so a visit with a full set of tests every two or three months fits.
- Free answers "keep and show". Paying answers "understand and use": questions, translation, a history past 50 documents.
- Prices are shown with VAT included (EU consumer prices). Paddle is the seller of record, collects the VAT and remits it; Omni Edge invoices Paddle without VAT.
- Limits start tight. Raising a limit later reads as a gift; lowering one reads as a bait and switch.
- Every paid plan has a monthly option. A small monthly payment is a lower barrier than an annual one, and a paying user at €2.49 still leaves ~€17 a year after all costs. Annual saves about 17-20% against 12 monthly payments.
- On monthly plans the one-off import is released in three monthly parts, so a single payment cannot take all of it.
- Paddle quotes custom pricing for products under $10: confirm the €2.49, €4.99 and €8.99 monthly prices and their fee with Paddle before launch. The fee (5% + $0.50) takes ~27% of a €2.49 payment after VAT.
### Plans
 
| Plan | Price (VAT included) | Pages added a month (rollover cap) | One-off import | Storage | Questions (chat) | Translation | Share links |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Trial | €0 for 6 months | 150 pages in total | included in the 150 | 5 GB | Yes, 50 questions in total | Yes, 30 translated pages in total | As Premium |
| Free | €0 | 3 (9) | none | 1 GB, max 50 documents | No | No (translation pack available) | 1 live link, 20 opens and 250 MB a month |
| Esențial | €2.49 a month or €24.90 a year | 5 (15) | 150 pages | 2 GB, unlimited documents | Yes | No (translation pack available) | Fair use, without translation |
| Premium | €49 a year or €4.99 a month | 30 (90) | 250 pages | 5 GB | Yes | Yes | Fair use, with translation |
| Family, up to 6 people | €89 a year or €8.99 a month | 60 pool, each account 30 (180 pool, 90 each) | 500 pool, each account 250 | 25 GB shared | Yes | Yes | Fair use, with translation |
| Founding member, first 500 payers | €39 a year, locked for life; on sale from day one, also during the trial | as Premium | as Premium | as Premium | Yes | Yes | as Premium |
| Self-host | Free | own model provider | | own | own | own | own |
 
Included on every plan: timeline, local search, links between documents found from the user's own data, export, emergency card, reminders. Paid plans add AI-found links, "similar by meaning" documents and approval mode for share links. Family adds child profiles, teen accounts and promotion at 18.
 
Add-ons:
 
| Add-on | Price | Includes | For |
| --- | --- | --- | --- |
| Translation pack (one trip) | €9.99 | Up to 50 pages translated into one language, for 30 days, including translation on share links | Free and Esențial |
| Page top-up | €19.99 | 250 extra pages added | Esențial, Premium, Family |
 
Not included anywhere: diagnosis or medical advice; certified (sworn) translation. Spine's translation is for a doctor to read the history, not for official use, and the app says so.
 
Hidden abuse ceilings (not advertised, there only against a broken or hostile app):
 
| Ceiling | Esențial | Premium, Founding | Family (household) |
| --- | --- | --- | --- |
| Pages read by the server (kept or not), a month | 2x the allowance | 2x the allowance | 2x the allowance |
| Questions, a month / rolling 12 months | 600 / 2,400 | 600 / 2,400 | 1,200 / 4,800 |
| Translated pages, a month / rolling 12 months | n/a | 800 / 3,000 | 1,600 / 6,000 |
| Link opens, a month | 5,000 | 5,000 | 10,000 |
| Link traffic, a month / rolling 12 months | 50 GB / 100 GB | 50 GB / 100 GB | 100 GB / 200 GB |
 
Free has the raw-pages ceiling too (2x its allowance). At a ceiling the single action is refused with a neutral message; nothing is silently degraded, and chat and translation always run on the full model. Ceilings live in config, never in the UI or the API.
 
The trial does not use these ceilings: it has its own visible totals (150 pages, 50 questions, 30 translated pages), decided 14 Nov 2026. After the trial, or at a trial limit, the archive stays fully visible and exportable; only adding and the paid-only features stop.
 
Why these numbers: a visit brings ~2 documents, ~5 pages. An occasional user (2 visits a year) adds ~10 pages a year and a regular one (6-8 visits) ~35, so Free (36 a year) covers most people who only need to keep and show. Esențial is for a history that has outgrown 50 documents and for asking questions; Premium for people who need translation, mostly the diaspora and patients treated abroad; Family for caregivers and parents. Recalibrate after the first months with real data.
 
### Economics per plan (€ a year)
 
| Plan | Net after VAT and Paddle | Typical AI cost | Left, typical use | Cost at the limit, year 1 | Left at the limit, year 1 |
| --- | --- | --- | --- | --- | --- |
| Free | 0 | ~0.40 | -0.40 | ~2.0 | -2.0 |
| Esențial €24.90 annual | ~19.07 | ~1.40 | ~17.67 | ~6.90 | ~12.17 |
| Esențial €2.49 monthly (12 payments) | ~18.19 | ~1.40 | ~16.79 | ~6.90 | ~11.29 |
| Premium €49 annual | ~37.95 | ~4.70 | ~33.25 | ~22.40 | ~15.55 |
| Premium €4.99 monthly (12 payments) | ~41.69 | ~4.70 | ~36.99 | ~22.40 | ~19.29 |
| Family €89 annual | ~69.28 | ~9.40 | ~59.88 | ~48.50 | ~20.78 |
| Family €8.99 monthly (12 payments) | ~79.29 | ~9.40 | ~69.89 | ~48.50 | ~30.79 |
| Founding €39 | ~30.12 | ~4.70 | ~25.42 | ~22.40 | ~7.72 |
| Translation pack €9.99 | ~7.39 | ~0.50 | ~6.89 | ~0.50 | ~6.89 |
| Page top-up €19.99 | ~15.22 | ~8.70 | ~6.52 | ~8.70 | ~6.52 |
 
Assumes 20% average VAT included in the price (to be recomputed at 21%, decided 14 Nov 2026), Paddle at 5% + $0.50 per payment, €1 = $1.15. "At the limit": every included page used, the full import, questions and (where included) translation into one language, plus the raw-pages ceiling on Free and Esențial. Chat abuse is outside this table and is bounded by the hidden ceilings.
 
Reading the table:
 
- Every paid plan stays positive even when a user takes everything included. Founding member has the thinnest margin (~€7.70 at the limit in year one): watch it with real data.
- Free costs ~€0.40 per user a year on average: the price of the growth loops (share links, emergency card, family invites).
- The trial is the bigger subsidy: ~€2 per sign-up (archive import on day one, ~€1.45, plus ~€0.60 of use). Six months stays because most people see a doctor only every two or three months; the length adds only the ~€0.60.
- Esențial earns about half of Premium per payer (~€17-18 against ~€33-37 a year): the salary threshold depends on how many payers come from the diaspora. Still, a payer at €2.49 is worth far more than a Free user, who costs ~€0.40 a year.
### Usage assumptions
 
| User type | Share of sign-ups | Documents at onboarding | New documents a year |
| --- | --- | --- | --- |
| Tries it out | 50% | ~5 | ~3 |
| Typical (tests, consultations, a few years) | 35% | ~40 | ~12 |
| Rich history (chronic condition, family archive) | 15% | ~150 | ~40 |
| Weighted average | | ~39 | ~12 |
 
Average document: 2.5 pages. A visit brings ~2 documents (~5 pages) and ~8 questions.
 
### AI cost (Gemini 3.5 Flash, EU regional endpoint)
 
| Item | Assumption | Cost |
| --- | --- | --- |
| Model price | $1.65 per 1M input tokens, $9.90 per 1M output tokens (regional, 10% above global) | n/a |
| Extraction, per page | ~2,500 input, ~1,500 output tokens (thinking included) | ~$0.019 |
| Summary and embedding, per document | ~3,000 input, ~400 output tokens | ~$0.009 |
| Reading a page, fully loaded | extraction plus the document overhead spread over 2.5 pages | ~$0.0225 |
| Chat message | ~6,000 input tokens (retrieved context), ~500 output | ~$0.015 |
| Translated page | ~1,000 input, ~1,000 output tokens; cached per document and language | ~$0.012 |
| Added page with questions, no translation | reading plus ~0.4 questions | ~€0.025 |
| Added page with questions and translation | as above plus translation into one language | ~€0.035 |
| Onboarding with the 150-page trial cap | heavy users capped | ~$1.45 per sign-up |
| Trial usage after onboarding | ~40% stay active | ~$0.60 per sign-up |
 
Cost per Premium payer by persona (€ a year): Light ~0.9 in year one / ~0.7 later, Typical ~4.6 / ~2.5, Heavy ~20.5 / ~9.4, Traveller in three languages ~39.8 / ~21.2; weighted ~7.6 in year one after trial reading, ~4.7 steady.
 
### Infrastructure cost (Google Cloud, EU region)
 
| Component | ~1,000 users | ~20,000 users |
| --- | --- | --- |
| Cloud Run: API and AI relay | ~$0-5 a month (mostly within the free tier) | ~$20-40 a month |
| Cloud SQL for PostgreSQL (encrypted metadata) | db-g1-small, ~$28-31 a month plus ~$5 storage and backups | db-standard-1, ~$54-59 a month plus ~$10 storage |
| Cloud Storage: encrypted documents (~50 MB per user) | 50 GB, ~$1 a month | 1 TB, ~$23 a month |
| Internet egress (~20 MB per active user a month, ~$0.12/GB) | ~$2 a month | ~$20 a month |
| Total | ~$40 a month (~$0.04 per user) | ~$130-150 a month (~$0.007 per user) |
| Later: Confidential Space relay | +~$150 a month | +~$150 a month |
 
Infrastructure is fixed and small; AI processing is the cost that scales with users.
 
### Technical constraints behind the limits
 
| Item | Outcome |
| --- | --- |
| Half-price batch import | Not built. Google's batch mode reads and writes plaintext in a storage bucket for up to a day, which breaks the zero-knowledge promise |
| Counting documents and kept pages | The server sees only sealed files, so the app reports documents and kept pages. A modified app can report less, but the server still meters every page it reads, so the raw-pages ceiling bounds the cost |
| Exports | Built on the device; the server cannot meter or refuse them |
| Share link life | 7 days by default, up to 30 |
| File size | The code allows 200 MB per file |
 
Decided: chat stays on the full model at every volume (11 Nov 2026); translation too. Cost levers that do not change answers: context caching, tighter retrieval.
 
### Revenue per paying user (Premium annual)
 
| Item | Value |
| --- | --- |
| Price shown, VAT included | €49 |
| VAT (20% average) | ~€8.17 |
| Paddle fee (5% + $0.50) | ~€2.88 |
| AI cost per year, steady state | ~€4.70 |
| AI cost, year one (after trial reading) | ~€7.60 |
| Net per year, steady state | ~€33.25 |
| 3-year value at 70% annual renewal | ~€70 |
 
### Conversion and break-even (all payers on Premium annual)
 
Benchmarks: freemium apps convert a median 2.1% to paid; reverse trials (full features, then a free plan) convert 4-6% (good) to 8-12% (great).
 
Cost per 1,000 sign-ups over the trial: ~€1,900 AI with the 150-page cap, ~€200 infrastructure, up to ~€550 of questions and translation: ~€2,650.
 
How to read the ~€2.65 per sign-up (clarified 14 Nov 2026): it is the average across the user mix, not the maximum. A "tries it out" account (half of sign-ups, about 12 pages) costs under €0.30. A heavy account reaches the 150-page cap, about €3 of reading plus its questions. With the Premium hidden ceilings an abusive trial account could have reached €60-70; with the visible trial totals decided on 14 Nov 2026 (150 pages, 50 questions, 30 translated pages) the maximum is about €4-5. Exposure if a launch post takes off: 5,000 sign-ups is about €13,000 with no revenue for six months, hence the monthly AI budget alert.
 
| Conversion | 3-year result per 1,000 sign-ups |
| --- | --- |
| 3% | ~-€550 |
| 6% | ~+€1,550 |
| 10% | ~+€4,340 |
 
Break-even conversion: ~3.8% over 3 years. At €39 with VAT included it would be ~5.0%, which is why the price moved to €49. Payers on Esențial bring about half as much each (at €2.49 / €24.90), so a mix with many Esențial payers needs a higher conversion.
 
Prudent scenario (review, 14 Nov 2026; add it to the sheet): 2% conversion, half of the payers on Esențial, 50% annual renewal gives about -€1,800 per 1,000 sign-ups over 3 years (computed at the old Esențial price; slightly better at €2.49 / €24.90).
 
Scale check: 20,000 sign-ups at 6% conversion is ~1,200 paying users, ~€40,000 a year on Premium annual.
 
Cost levers if conversion runs low: Gemini 3.5 Flash-Lite for extraction only, and only if tests on real medical documents show no loss in accuracy; context caching for chat; a lower thinking budget; Gemini 3.6 Flash (cheaper output). Batch processing is not an option (zero-knowledge).
 
### Public pricing copy (draft)
 
Headline: "Everything you add stays fully usable. We only limit how much you add each month."
 
- **Free:** keep up to 50 documents and add 3 pages a month (unused pages add up for 3 months). Timeline, search, export, your emergency card and one share link.
- **Esențial, €2.49 a month or €24.90 a year:** add 5 pages a month, plus a one-time 150-page import of your history. Unlimited documents. Ask questions about your own records.
- **Premium, €49 a year or €4.99 a month:** add 30 pages a month, plus a one-time 250-page import. Questions and translation for doctors in other countries, with no monthly limit for normal use. As many share links as you need.
- **Family, €8.99 a month or €89 a year:** Premium for up to 6 people, with a shared pool of 60 pages a month and a 500-page import.
- **Founding member, €39 a year for life:** Premium at the launch price, for the first 500.
- **Trial, free for 6 months:** everything in Premium, with 150 pages, 50 questions and 30 translated pages in total. Your archive stays visible and exportable afterwards.
- **Going abroad once?** Translation pack, €9.99: up to 50 pages translated for 30 days.
What counts: "A page counts when it stays in your archive. Asking questions, translating, searching, sharing and exporting never count, and pages you reject after reading don't count either."
 
Fair-use note: "Questions, translation and share links have no monthly limit for normal personal use. We may slow or pause automated or abusive use. This never affects normal use of your own records." Translation note: "Translations help a doctor read your history. They are not certified translations." This is not legal advice; check the wording against consumer-protection rules before publishing.
 
## Day-one metrics and dashboard
 
Added 14 Nov 2026. With a 6-month trial, the first trial payments arrive in May 2027, so early decisions rest on leading indicators: who imports, who shares with a doctor, who asks a question, and who buys Founding member.
 
Privacy first: no third-party analytics or ad pixels in the app or on the site. The app reports counts and events without content (never a document, a value or a question). Server-side figures come from what the server already sees: pages read through the relay, bytes stored, link opens, payments. The website uses a self-hosted, cookie-free counter (Plausible or Umami). Describe all of it in the privacy policy.
 
### What to track from day one
 
| Area | Metric | Source | First guardrail (revise after week 4) |
| --- | --- | --- | --- |
| Acquisition | Sign-ups a day by source: Reddit, HN, Product Hunt, LinkedIn, diaspora groups, share-link footer, emergency card, family invite | UTM and referral code at sign-up | Watch which 2-3 channels bring activated users, not just sign-ups |
| Acquisition | Site visit to sign-up | Site counter | n/a |
| Activation (7 days) | Import done (5+ documents kept) | App counter | 40% of sign-ups |
| Activation (30 days) | First share link created; first link opened by someone else | Server | 15% create, most of them opened |
| Activation (30 days) | First question in chat; first translation | Relay | 25% ask a question |
| Activation (30 days) | Emergency card set up; family member invited | App counter, server | n/a |
| Engagement | Active at 30, 60, 90 days (any upload, view, share or question) | App and server | n/a |
| Engagement | Pages kept per active user a month; visits (upload bursts) a quarter | App counter | Compare with the 5 pages per visit assumption |
| Monetisation | Founding member sales a week and in total (of 500) | Paddle webhooks | Earliest real signal: review weekly |
| Monetisation | Upgrade prompts shown, clicked and paid, by trigger (after a share, after an answer, after a translation, at a limit, trial ending) | App events, Paddle | Keep the triggers that convert |
| Monetisation | Plan mix, net revenue after VAT and Paddle, refunds, cancellations | Paddle webhooks | n/a |
| Monetisation | Trial to paid, by sign-up cohort (from month 6) | Paddle, app | 3.8% to break even |
| Limits | Users hitting each limit (Free 50 documents, Free and Esențial pages, rollover used) and how many pay within 30 days | App, server | If almost nobody pays after a limit, the limit is in the wrong place |
| Cost | AI cost a month by plan and per active user; Free plus trial AI cost as a share of net revenue | GCP billing export, relay logs | At most 20% of net revenue |
| Cost | Accounts above €15 of AI a month; hidden-ceiling hits | Relay logs | Investigate every one |
| Quality | Kept pages / pages read (extraction acceptance) | App counter, relay | 80% or more; lower means extraction needs work |
| Quality | Support tickets and feature requests a week, by topic | Support inbox | n/a |
| Growth loops | Sign-ups from share-link footer, emergency card and family invites | Referral codes | Share of all sign-ups, trending up |
 
### Dashboard (internal page)
 
An internal admin page in Spine, behind login, for Alex and the marketing role only.
 
- **Today / 7 days / 30 days:** sign-ups, activated users, Founding sales, net revenue, AI cost, cost as a share of revenue.
- **Funnel:** sign-up → import done → first share → first question → paid, overall and by source.
- **Cohorts:** by sign-up week: activation, 30/60/90-day activity, later trial-to-paid.
- **Revenue:** plan mix, Founding count of 500, add-on sales, refunds and cancellations (Paddle webhooks).
- **Costs:** AI and infrastructure by plan (GCP billing export to BigQuery plus relay logs).
- **Limits and abuse:** limit hits and conversion after them, hidden-ceiling hits, accounts above €15 a month.
- **Quality and growth loops:** acceptance rate, link and card referrals.
Each indicator shows its guardrail and turns amber or red when crossed. Review weekly for the first 3 months; decide on limits, prices and channels at month 3 with real data.
 
## Sources
 
Launch and community:
 
- [Bitwarden: Q&A with the founder, first launch on Reddit, Hacker News and Product Hunt](https://bitwarden.com/blog/q-and-a-with-bitwarden-founder-and-cto/)
- [Fast Company: Bitwarden's early growth through Reddit communities](https://www.fastcompany.com/91117788/how-bitwarden-is-fending-off-tech-giants)
- [It's FOSS: interview with Bitwarden's founder on open source and trust](https://news.itsfoss.com/kyle-spearrin-bitwarden-interview)
Conversion benchmarks:
 
- [RevenueCat: State of Subscription Apps 2026 (freemium median 2.1%)](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)
- [ChartMogul: SaaS conversion report](https://chartmogul.com/reports/saas-conversion-report/)
- [Userpilot: freemium and reverse-trial conversion rates, citing ChartMogul 2026](https://userpilot.com/blog/freemium-saas/)
Pricing references:
 
- [PricingSaaS: Bitwarden price changes, 2026](https://pricingsaas.com/companies/bitwarden/diffs/2026Q1)
- [Paddle fees: 5% + $0.50, custom pricing under $10](https://resources.rework.com/tools/billing-revenue/paddle-vs-lemon-squeezy)
AI and infrastructure costs:
 
- [Vertex AI generative AI pricing (official)](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [LLM Reference: Gemini 3.5 Flash on Vertex AI, $1.50 / $9.00 per 1M tokens](https://www.llmreference.com/model/gemini-3.5-flash/gcp-vertex-ai)
- [UsagePricing: Gemini regional endpoints priced 10% above global](https://www.usagepricing.com/blueprint/activity/google-gemini-2026-04-01-gemini-3-regional-pricing)
- [Gemini 3.5 Flash-Lite pricing](https://pricepertoken.com/pricing-page/model/google-gemini-3.5-flash-lite)
- [Cloud Run pricing (official)](https://cloud.google.com/run/pricing)
- [Cloud SQL pricing (official)](https://cloud.google.com/sql/pricing)
- [Bytebase: Cloud SQL db-g1-small monthly price by region](https://www.bytebase.com/dbcost/cloudsql/instance/db-g1-small/)
- [Bytebase: Cloud SQL db-standard-1 monthly price by region](https://www.bytebase.com/dbcost/cloudsql/instance/db-standard-1.md)
- [Cloud Storage pricing (official)](https://cloud.google.com/storage/pricing)
- [Impossible Cloud: EU storage and egress pricing comparison](https://www.impossiblecloud.com/magazine/cheapest-s3-storage-eu-pricing-comparison)
Trademark, IP and tax (review, 14 Nov 2026):
 
- [StartupCafe: taxation of copyright income in 2026](https://startupcafe.ro/?p=109378)
- [Impozitul.ro: copyright income tax 2026, CASS thresholds](https://impozitul.ro/impozit-drepturi-autor)
- [MHC: EUIPO SME Fund 2026](https://www.mhc.ie/latest/insights/euipo-sme-fund)
- [Quasa: OSIM fees at filing](https://quasa.io/ro/media/marca-osim-nu-costa-o-singura-taxa-plata-ratata-poate-inchide-cererea)
- [Avocatnet.ro: registered trademarks and online business (EUIPO base fee)](https://www.avocatnet.ro/articol_50644/Marca-inregistrat%C4%83-%C8%99i-activit%C4%83%C8%9Bile-din-mediul-online.html)
- [Subscription Insider: Apple's EU App Store fees from 1 Oct 2026](https://www.subscriptioninsider.com/blog/apple-sets-new-eu-app-store-fees)
