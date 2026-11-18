# Operator checklist

What the person who runs an instance has to do or confirm that the software cannot do or check for them. The software refuses to start on a missing, short or placeholder `SESSION_SECRET`, on open registration without a mailer, on page images without the second switch and on a Vertex model without its endpoint, region and project; everything below is what it does not catch. Each line says where the detail is, so this page does not repeat it.

Tick these before the first real user, and again after changing provider, host or domain.

## Before you start

- [ ] **Decide who the controller is.** The operator of an instance is the controller of what it holds (SECURITY.md, "Distribution and who owns the risk"). Set `SPINE_OPERATOR_NAME` and `SPINE_OPERATOR_CONTACT` so the privacy notice and terms name you ([docs/legal/](legal/), `SPINE_LEGAL_DIR` to replace the drafts).
- [ ] **Have the texts reviewed by a lawyer.** `docs/legal/privacy.md`, `terms.md`, `purpose.md` and `refunds.md` and the drafts in [docs/compliance/](compliance/) are first drafts written from what the software does; nothing in them has been reviewed by one. The Romanian and EU citations in [requirements.md](requirements.md) were looked up on 2026-10-24 and need a lawyer's confirmation.
- [ ] **Choose where inference runs** ([setup.md](setup.md) step 0). If data must stay in the EU, use Vertex AI at an `eu` endpoint with a service account; the Anthropic adapter makes no such commitment ([deployment-gcp.md](deployment-gcp.md)). A provider outside the EU or EEA is a transfer that needs a basis under Chapter V before you use it (requirements `CR-GDPR-05`).
- [ ] **Decide whether page images may leave the machine.** Off by default. It takes two settings, `SPINE_PARSER` of `multimodal` or `hybrid` and `SPINE_MULTIMODAL_ENABLED=true`; photos and signature stamps need the second one as well ([setup.md](setup.md)).

## Contracts and settings that live outside this repository

None of these can be seen from the code. Each needs you to look at the provider's console or paper.

- [ ] **Model provider retention.** Vertex AI: disable data caching on the project, request the abuse-monitoring exception, leave request-response logging off, no Grounding with Google Search or Maps, regional EU endpoints only ([relay.md](relay.md), "Before the first real user"). The claim "keeps nothing" in [key-hierarchy.md](key-hierarchy.md) is a contract, not a property of the code.
- [ ] **Processing agreements** with the hosting, model, relay-hosting and email providers (`CR-GDPR-05`).
- [ ] **Mail provider.** For Brevo: a DKIM-signed sending domain, an API key (not the SMTP key), a neutral `SPINE_MAIL_SENDER`, and its data processing agreement read, since what is public about its EU hosting and certifications is third-party summary ([setup.md](setup.md) step 5, ARCHITECTURE.md "The mail path").
- [ ] **Log retention.** The records of processing say security logs are kept up to 12 months ([compliance/ropa.md](compliance/ropa.md)). Nothing in the software enforces that: set it in your host's log rotation.
- [ ] **Hosting region and the relay's region.** Put the relay service itself in an EU region and do not enable request-body logging there ([relay.md](relay.md)).
- [ ] **Signature authorities.** If you want a doctor's digital signature shown as verified, put the certificates you trust in `SPINE_TRUST_ANCHORS_DIR` (for Romania, the qualified trust service providers on the EU trusted list). With none, a signature is a label (SECURITY.md **S-23**).
- [ ] **Whether other duties apply to you:** accessibility, NIS2, the Cyber Resilience Act's reporting duty, a data protection officer (requirements `CR-ACC-01`, `CR-NIS-01`, `CR-CRA-01`, `CR-GDPR-13`).

## Plans, the card and families (only if you use them)

None of these can be seen from the code either.

- [ ] **Payment provider.** Make a Stripe account and test everything with a test key (`sk_test_` or `rk_test_`) before a live one ([billing.md](billing.md)): make the webhook endpoint for `/api/billing/webhook` with the events listed there, set the customer portal as described there, and **buy once with a test card** and watch the account become Premium, then cancel from the portal. You are the seller, so the refunds, the fourteen days offered on the pricing page and the VAT on the invoices are yours. Sign its data processing agreement (`CR-PAY-01`, `CR-GDPR-05`).
- [ ] **The sandbox key.** If a Stripe key was ever pasted into a chat, a ticket or a log, revoke it in the dashboard and make a new one.
- [ ] **The wording of cancellation and refund.** The terms and the pricing page say you cancel from your account on the provider's page and can have your money back in the first 14 days. Confirm both with the provider's actual flow and with a lawyer; the software only links to the portal.
- [ ] **A lawyer on the family features** (`CR-FAM-01` to `CR-FAM-03`): sixteen as the age for an account of their own and the guardian's invitation as the consent (Romania has not lowered the age in GDPR Art. 8; check it still holds when you launch), and whether a young person may hide records from their guardians before eighteen, which the software does not do.
- [ ] **A lawyer on the emergency card** (`CR-EMG-01`): that turning it on, after the page says anyone with the code reads it, is a valid explicit consent for what you let people put on it, including identification numbers, and for a card kept for a child.
- [ ] **Object storage, if you use a bucket** ([deployment-gcp.md](deployment-gcp.md)): an EU location, uniform access, public access prevented, versioning or soft delete on, a lifecycle rule that expires old versions (so an erased account's ciphertext does not outlive the retention you state), and `roles/storage.objectAdmin` for the server's account only. The software checks none of these.
- [ ] **Postgres, if you use it:** an EU region, TLS (`sslmode=require`), the host's automated backups and point-in-time recovery switched on and a restore tried; `backup.ts` makes no snapshot of it.
- [ ] **A mailer**, if you want the yearly card reminders and the notices of an invitation accepted or a card opened to be sent: without one the app still shows its own prompts, and nothing is mailed.

## Deploying

- [ ] **Secrets.** `SESSION_SECRET` of at least 32 random characters; `SPINE_RELAY_SECRET` the same on the server and the relay. Rotating `SESSION_SECRET` later ends every session and makes every enrolled authenticator unreadable (SECURITY.md **S-21**, "Operational response").
- [ ] **The relay.** Deploy it from [relay.md](relay.md) with the provider's credential and `SPINE_RELAY_ORIGIN`; put its address in `SPINE_RELAY_URL` on the server. Without them a device cannot call a model.
- [ ] **Vertex only:** `SPINE_LLM_ENDPOINT`, `SPINE_LLM_REGION`, `SPINE_LLM_PROJECT` stated, no `GOOGLE_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY` anywhere in the relay's environment, a service-account key for the relay only.
- [ ] **TLS and the proxy.** A certificate for `SPINE_DOMAIN`; ports 80 and 443. Behind a proxy of your own, name its address in `SPINE_TRUSTED_PROXIES` and make it overwrite `X-Forwarded-For` ([self-host.md](self-host.md), SECURITY.md **S-31**). The server binds loopback unless `SPINE_HOST` says otherwise.
- [ ] **Registration.** `operator` (default) or `open`, which needs a working mailer.
- [ ] **A memory ceiling for the web service.** Reads of sealed objects are streamed, but the server still holds a body in memory while it is written (up to `SPINE_VAULT_MAX_OBJECT_MB`) and nothing in the unit limits the process, so on a small host a burst of large uploads can take the machine's memory. Choose `MemoryMax=` for `spine-web` from the host's memory (a drop-in with `systemctl edit spine-web`), so that the one service is stopped and restarted, not the host (SECURITY.md **S-58**).
- [ ] **Backups off the disk.** The daily backup lands beside `data/` by default, which does not survive losing the disk. Point `SPINE_BACKUP_DIR` at other storage; `install.sh -s` gives the backup service access to it ([setup.md](setup.md)).

## On Cloud Run: the services and accounts it needs

What has to exist before the steps of [deploy-cloud-run.md](deploy-cloud-run.md) can finish. Each is an account or a service somewhere else.

- [ ] **A Google Cloud project with billing**, and `gcloud` signed in as someone who may enable services and set IAM. The services to enable are in step 1: Cloud Run, Cloud SQL Admin, Secret Manager, Artifact Registry, Cloud Scheduler, Cloud Build, Vertex AI, and Compute Engine (needed only for a load balancer). Cloud Storage is on in a new project.
- [ ] **Vertex AI model access.** The model the relay calls has to be available to the project at the `eu` endpoint, and Claude on Vertex is enabled in Model Garden by an administrator ([relay.md](relay.md)).
- [ ] **A domain whose DNS records you can set,** verified with Google (`gcloud domains verify`, which asks for a record at the registrar) before a domain mapping can be made. The same verification serves Search Console, which you add after the first deploy ([deploy-cloud-run.md](deploy-cloud-run.md), step 10).
- [ ] **A place for the images:** the Artifact Registry repository of step 1, and the images in it, built with Cloud Build or `scripts/publish-images.sh`. Images from a release tag are at `ghcr.io`, which Cloud Run reaches through an Artifact Registry remote repository ([verify-build.md](verify-build.md#official-images)).
- [ ] **Postgres and the bucket** of steps 3 and 4, and the two service accounts of step 5 with the roles listed there.
- [ ] **The mail provider** (Brevo, above): the sending domain's records at the registrar and the API key in Secret Manager. `SPINE_REGISTRATION=open` refuses to start without it.
- [ ] **Stripe,** if you use plans (above): the webhook's address once the domain answers.
- [ ] **Stripe's prices, all of them tax-inclusive and in one currency:** Premium's yearly and monthly and the founding yearly price, Essential's two and the family plan's two if you sell them, and the 250-page top-up (a price that does not repeat), their ids in `SPINE_STRIPE_PRICE_*` ([billing.md](billing.md)). Spine reads every amount it shows from them, so a price that is missing or in another currency shows no amount. **Take the founding price off sale in Stripe when the count of places reaches 500** (the admin page shows it, and the catalog's button does it): Spine stops offering it at 500, but a checkout opened at Stripe for that price id would still sell it.
- [ ] **The administrator, before the first sign-in:** `SPINE_ADMIN_EMAILS` (and `SPINE_MARKETING_EMAILS` for a read-only role), then sign in at `/admin`. It is not linked from anywhere. Set the AI budget and the targets there, and leave the secrets, prices and the model in the environment.
- [ ] **The scanners, before the deploy:** `./scripts/check.sh scan` (gitleaks and semgrep) and `npm audit`, which the review of the marketing work did not run ([security-review.md](security-review.md), pass 15).
- [ ] **The country file's source reachable.** The hourly job downloads it from GitHub's releases (`ip-location-db`), so the job needs outbound internet, which Cloud Run has by default. If it is blocked, countries stay unknown and the job's log says so.
- [ ] **For releases from GitHub:** a repository with Actions on, and Packages for `ghcr.io`. The first tag is the first run of the workflows ([verify-build.md](verify-build.md)).

## Check that it did what you meant

- [ ] **Say which commit you run, and check it.** The page's footer shows the commit and `/trust` explains the check to your users in plain words (set `SPINE_REPO_URL` so its links to the code, docs and security page work). For an official release, tag it (`git tag vX.Y.Z && git push origin vX.Y.Z`), wait for the release workflow, deploy the tag and run `./scripts/deploy-check.sh vX.Y.Z`. Then build it yourself and run `node scripts/verify-build.mjs https://<your domain> web/dist` ([verify-build.md](verify-build.md)): it must say `ok`. Do it after each update; a user who runs it against you gets the same answer.

- [ ] **What the host looks like.** On the host, `./scripts/host-report.sh > report.txt` lists the modes of `data/` and the backup, the listening ports, how systemd runs the three units, free space, the backup's last runs, a restore of the newest snapshot (on a copy); from another machine, `./scripts/host-report.sh outside <your domain>` lists the TLS versions and security headers it sees. It reads only, prints no value from `.env` and blanks email addresses; the lines that need `sudo` (firewall, nginx) say so when they cannot run. Read it against the items above.
- [ ] **The startup lines.** The server logs `model settings given to devices` with the provider, model, endpoint, parser and whether page images may leave; the relay logs `relay ready` with the provider, model, endpoint and region it will call. Read them against what you intended.
- [ ] **Residency, from the provider's side.** After the first real model call, read the provider's request log and confirm the EU host served it. That is the only check that works for any provider (SECURITY.md **M-8**).
- [ ] **Restore once.** Restore a backup to a blank machine before you need it ([SECURITY.md](../SECURITY.md#operational-response), "Restoring"). `./scripts/host-report.sh` restores the newest snapshot onto a copy and checks it, which is not the same as a restore to a blank machine.
- [ ] **Sign in as a second person** and confirm they see nothing of the first (the tests do this; do it on your own deployment too).
- [ ] **Create one share link, open it in a private window, then revoke it** and confirm the copy no longer opens.
- [ ] **Turn on two-factor** for your own account and keep the recovery codes and the recovery kit somewhere that is not the same place as the password. Two-factor is optional and cannot be required of other users (SECURITY.md **S-20**).

## Keeping it up

- [ ] **Update on a schedule.** `./install.sh -b` stops on a high or critical advisory; advisories published later are only found at the next build (SECURITY.md **S-32**). Take a backup before updating: there is no migration runner, and a database of an older shape is refused at startup.
- [ ] **A way to be told of a vulnerability.** Set `SPINE_OPERATOR_SECURITY_CONTACT` (or `SPINE_OPERATOR_CONTACT`, which it falls back to): the server publishes it as the `Contact:` of `/.well-known/security.txt` (an address or a link; without one the file is a 404, since the standard requires a contact), behind nginx, Caddy or alone. Set `SPINE_REPO_URL` for the `/security` redirect (SECURITY.md, "Reporting a vulnerability").
- [ ] **A breach plan.** [compliance/breach-procedure.md](compliance/breach-procedure.md): 72 hours to the supervisory authority when there is a risk to people, and the containment steps in SECURITY.md, "Operational response".
- [ ] **Re-read this page** when you change provider, region, mailer or host.

## What is not covered by anything yet

So you do not assume otherwise: nothing has been audited or tested by an outside party; the OCR and page-reading thresholds are first guesses to tune on your own documents.
