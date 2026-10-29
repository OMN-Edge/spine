# Operator checklist

What the person who runs an instance has to do or confirm that the software cannot do or check for them. The software refuses to start on a missing, short or placeholder `SESSION_SECRET`, on open registration without a mailer, on page images without the second switch and on a Vertex model without its endpoint, region and project; everything below is what it does not catch. Each line says where the detail is, so this page does not repeat it.

Tick these before the first real user, and again after changing provider, host or domain.

## Before you start

- [ ] **Decide who the controller is.** The operator of an instance is the controller of what it holds (SECURITY.md, "Distribution and who owns the risk"). Set `SPINE_OPERATOR_NAME` and `SPINE_OPERATOR_CONTACT` so the privacy notice and terms name you ([docs/legal/](legal/), `SPINE_LEGAL_DIR` to replace the drafts).
- [ ] **Have the texts reviewed by a lawyer.** `docs/legal/privacy.md`, `terms.md` and `purpose.md` and the drafts in [docs/compliance/](compliance/) are first drafts written from what the software does; nothing in them has been reviewed by one. The Romanian and EU citations in [requirements.md](requirements.md) were looked up on 2026-10-24 and need a lawyer's confirmation.
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

## Deploying

- [ ] **Secrets.** `SESSION_SECRET` of at least 32 random characters; `SPINE_RELAY_SECRET` the same on the server and the relay. Rotating `SESSION_SECRET` later ends every session and makes every enrolled authenticator unreadable (SECURITY.md **S-21**, "Operational response").
- [ ] **The relay.** Deploy it from [relay.md](relay.md) with the provider's credential and `SPINE_RELAY_ORIGIN`; put its address in `SPINE_RELAY_URL` on the server. Without them a device cannot call a model.
- [ ] **Vertex only:** `SPINE_LLM_ENDPOINT`, `SPINE_LLM_REGION`, `SPINE_LLM_PROJECT` stated, no `GOOGLE_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY` anywhere in the relay's environment, a service-account key for the relay only.
- [ ] **TLS and the proxy.** A certificate for `SPINE_DOMAIN`; ports 80 and 443. Behind a proxy of your own, name its address in `SPINE_TRUSTED_PROXIES` and make it overwrite `X-Forwarded-For` ([self-host.md](self-host.md), SECURITY.md **S-31**). The server binds loopback unless `SPINE_HOST` says otherwise.
- [ ] **Registration.** `operator` (default) or `open`, which needs a working mailer.
- [ ] **Backups off the disk.** The daily backup lands beside `data/` by default, which does not survive losing the disk. Point `SPINE_BACKUP_DIR` at other storage; `install.sh -s` gives the backup service access to it ([setup.md](setup.md)).

## Check that it did what you meant

- [ ] **The startup lines.** The server logs `model settings given to devices` with the provider, model, endpoint, parser and whether page images may leave; the relay logs `relay ready` with the provider, model, endpoint and region it will call. Read them against what you intended.
- [ ] **Residency, from the provider's side.** After the first real model call, read the provider's request log and confirm the EU host served it. That is the only check that works for any provider (SECURITY.md **M-8**).
- [ ] **Restore once.** Restore a backup to a blank machine before you need it ([SECURITY.md](../SECURITY.md#operational-response), "Restoring"). This has not been rehearsed for this repository.
- [ ] **Sign in as a second person** and confirm they see nothing of the first (the tests do this; do it on your own deployment too).
- [ ] **Create one share link, open it in a private window, then revoke it** and confirm the copy no longer opens.
- [ ] **Turn on two-factor** for your own account and keep the recovery codes and the recovery kit somewhere that is not the same place as the password. Two-factor is optional and cannot be required of other users (SECURITY.md **S-20**).

## Keeping it up

- [ ] **Update on a schedule.** `./install.sh -b` stops on a high or critical advisory; advisories published later are only found at the next build (SECURITY.md **S-32**). Take a backup before updating: there is no migration runner, and a database of an older shape is refused at startup.
- [ ] **A way to be told of a vulnerability.** Edit the `Contact:` line of `nginx/security.txt` before `install.sh -n`, which copies it to `/.well-known/security.txt` and renews its expiry yearly: the template names the author's address, so on another operator's instance reports would go to the author. Set `SPINE_REPO_URL` for the `/security` redirect (SECURITY.md, "Reporting a vulnerability").
- [ ] **A breach plan.** [compliance/breach-procedure.md](compliance/breach-procedure.md): 72 hours to the supervisory authority when there is a risk to people, and the containment steps in SECURITY.md, "Operational response".
- [ ] **Re-read this page** when you change provider, region, mailer or host.

## What is not covered by anything yet

So you do not assume otherwise: nothing has been audited or tested by an outside party; Anthropic behind the relay has never been run live (Vertex has, on invented records); a real Brevo send and the CI browser jobs on a real runner have not been run; the OCR and page-reading thresholds are first guesses to tune on your own documents (ARCHITECTURE.md, "Not done yet").
