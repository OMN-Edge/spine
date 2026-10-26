# GCP deployment reference: private LLM pipeline

Distilled from a research note dated **10 October 2026**. Read the [Confidence](#confidence-and-provenance) section before acting on any figure here.

Target: run Spine's model calls on **Vertex AI through the EU multi-region endpoint**, from a single least-privilege service account, with Google sign-in kept on non-sensitive OAuth scopes.

Relevant to Spine because the archive holds EU medical data, so where inference is *processed* is a compliance property, not a performance one.

## Why this matters for Spine

Every model call is made by the owner's device and goes through the relay ([relay.md](relay.md)), which runs it through the provider you configure: Anthropic's API directly (the default), or Vertex. Document text leaves the device on every call. Moving the relay to Vertex in the EU multi-region keeps ML processing inside EU member states, which is the main reason to prefer it over calling providers directly.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the current egress path and [SECURITY.md](../SECURITY.md) principle **P8** (egress is minimal, enumerated, text-only).

## Residency: the endpoint decides, not the model

**EU residency comes from the endpoint you call, not the model name.** Every request must go to the `eu` multi-region.

- **Endpoint:** location `eu`, host `https://aiplatform.eu.rep.googleapis.com`. Google states ML processing then stays within EU member states.
- **Never use `global`.** Google warns against it when you have ML processing requirements, because you cannot know where the request is handled.
- **Single regions** (`europe-west1` Belgium, `europe-west4` Netherlands) serve older Claude 4.x models. Reports say Sonnet 5 and the newest Opus models are only on the `eu` multi-region.
- **Use a service account via Application Default Credentials, not an API key.** Verified, and stronger than the original note suggested:
  - API keys work only on **Vertex AI Express** endpoints and are **blocked on standard Vertex endpoints** — the ones carrying the `eu` multi-region guarantee. OAuth/ADC works on all endpoints.
  - **Claude on Vertex cannot use an API key at all**: it is served via `rawPredict`, which does not support API-key auth.
  - The location bug is real and **unfixed**. [google-gemini/gemini-cli#27984](https://github.com/google-gemini/gemini-cli/issues/27984) reports that when `GOOGLE_API_KEY` is set, `@google/genai` defaults to the global endpoint and **silently ignores `GOOGLE_CLOUD_LOCATION`**, while the CLI still displays the configured region. The root cause was traced to the library defaulting to global whenever an API key is present. It was **closed as "not planned"** on 1 September 2026 after going stale, with no maintainer resolution — so this is current behaviour, not a historical defect. The reporter raised it as precisely a GDPR/residency problem: users choosing Vertex for data residency get no warning that processing may leave their region.
- **Confirm the host in request logs.** Do not assume the SDK routed correctly.
- **Private Google Access is not supported** for multi-region endpoints. Use Private Service Connect if the network is private.
- Google states prompts and responses are **not shared with third parties** when using the Vertex AI API, including partner models such as Claude.
- Turn on **Data Access audit logs** for Vertex AI, so there is a record of which calls were made and from where. This also serves **P7**-style auditability.

## Models

Two have documented EU processing and accept images: Gemini 3.8 Flash and Claude Sonnet 5.

| Model | Vertex model ID | EU processing | USD / 1M tokens (in / out) | Role |
|---|---|---|---|---|
| Gemini 3.8 Flash | `gemini-3.8-flash` | EU multi-region, at rest + ML processing | ~0.83 / ~4.13 | First pick; cheapest |
| Claude Sonnet 5 | `claude-sonnet-5` | EU multi-region | ~2.20 / ~11.00 | Strongest reasoning of the two |
| Claude Opus 5 | `claude-opus-5` | EU multi-region | ~5.50 / ~27.50 | Hard cases only, not default |
| Claude Sonnet 5.5 / Opus 5.5 | `claude-sonnet-5-5`, `claude-opus-5-5` | **Not in Google's residency table** as of 10 Oct 2026 | 2.00 / 10.00, 4.00 / 20.00 (Anthropic list, pre-EU premium) | Verify in Model Garden first |

- EU multi-region endpoints carry roughly a **10% premium** over global list prices.
- **Gemini 3.8 Flash pricing is introductory and ends 31 December 2026**, then roughly doubles. Do not build a cost model that assumes it persists.
- **Claude Sonnet 5 retirement is no sooner than 24 December 2026.** Keep model IDs in configuration, never in code — this is the concrete reason Spine needs a provider/model abstraction rather than a hardcoded SDK call.
- **Avoid gateways/routers** (e.g. Requesty). They add a second data processor to the privacy policy. Call Vertex directly.

### Cost sketch

At ~1,500 input and ~500 output tokens per page: about **$0.003/page** on Gemini 3.8 Flash and **$0.009/page** on Claude Sonnet 5. Rough, EU list prices.

### Quality is unvalidated for this use case

The handwriting benchmarks found tested other models (Gemini 3 Pro, GPT-5, Claude Sonnet 4.5) and **none covered Romanian diacritics**. Run 50–100 real Romanian handwriting samples through both candidates before choosing. This is a real evaluation task, not a config change.

## IAM

One role to call models. Enabling Claude needs a second role, held by a human for a one-time step, never by the application.

| Principal | Role | Purpose |
|---|---|---|
| App service account | `roles/aiplatform.user` | Includes `aiplatform.endpoints.predict` — calls Gemini and Claude |
| Human admin, once | `roles/consumerprocurement.entitlementManager` | Enables Claude (partner model) in Model Garden, accepts terms |
| Nobody | `roles/aiplatform.admin` | Not needed to call models. Do not grant. |

- **Tighter option:** a custom role with only `aiplatform.endpoints.predict`. Reported to cover both Gemini and Claude inference — test before relying on it.
- **Organization policy:** if a policy restricts Model Garden models, it must allow partner models or Claude will not enable.
- **No downloaded JSON keys.** If the workload runs on Google Cloud, attach the service account to it. If it runs elsewhere — a Raspberry Pi, for instance — use **workload identity federation**, not a key file.

### What this means in practice on a Pi

Vertex authenticates with **Application Default Credentials (ADC)**, not an API key. ADC is a lookup order, and off-GCP the practical entry in it is a key file:

1. In the console, create the service account and grant `roles/aiplatform.user`.
2. Create a key for it. The console downloads a **JSON file** — this is the only moment it is available, and it does not expire.
3. Put it on the host outside the repo, owned by the service user, readable only by it: `/etc/spine/vertex-sa.json`, mode `600`.
4. Point ADC at it and name the project, endpoint and region (these are the relay's settings, [relay.md](relay.md)):

   ```
   GOOGLE_APPLICATION_CREDENTIALS=/etc/spine/vertex-sa.json
   SPINE_LLM_PROVIDER=vertex
   SPINE_LLM_PROJECT=<gcp-project-id>
   SPINE_LLM_ENDPOINT=aiplatform.eu.rep.googleapis.com   # the multi-region host; never a global one
   SPINE_LLM_REGION=eu
   SPINE_LLM_MODEL=gemini-3.8-flash
   ```

Google's client libraries read `GOOGLE_APPLICATION_CREDENTIALS` automatically, so no credential handling appears in application code. So: yes — download a file, set a path.

**Why the guidance resists this.** A key file is a bearer credential that never expires, sitting on disk. On GCP you avoid it by attaching the service account to the workload; off GCP, workload identity federation avoids it but needs an external OIDC identity a Pi does not have. The file is the pragmatic answer, so the handling policy carries the weight instead:

- Never in the repo, never in `DATA_DIR`, and **excluded from any backup that leaves the host** — it is not covered by the `data/` backup set for exactly this reason.
- `systemd` passes it by path; it is not an application secret and never reaches the DB.
- Rotate on a stated cadence, and on any suspicion disable the key in IAM — revocation is server-side and immediate, which is the one advantage over a password.
- Grant only `roles/aiplatform.user`. A leaked key is then limited to inference spend on one project, not data access.

The alternative is to accept no residency guarantee and use an API-key provider (the Gemini API, or Anthropic directly), which is a different product with different compliance properties — not a simpler way to get the same thing.

## Google sign-in and Drive (optional)

Relevant only if Spine adopts Google as an identity provider or Drive as an upload source. Request sign-in scopes plus `drive.file` and nothing more; that avoids restricted-scope verification and the annual CASA security assessment.

| Scope | Tier | Review burden |
|---|---|---|
| `openid`, `email`, `profile` | Non-sensitive | Basic brand check if showing name/logo |
| `.../auth/drive.file` | Non-sensitive | No security assessment; publishing is self-serve |
| `drive`, `drive.readonly` | **Restricted** | Full verification + annual CASA. Do not request. |

**One restricted scope anywhere in the project puts the whole project in the restricted tier.** This is a hard constraint on the GCP project's design.

- **Upload folder:** the app creates its own folder on first use, stores the folder ID, and parents every upload to it. Files the app creates stay accessible under `drive.file`.
- **Send the image to the model at upload time**, while the app still holds it, rather than reading it back from Drive.
- **Testing mode** caps at 100 users with 7-day refresh-token expiry; both end on publish.
- **Internal consent screen** needs no verification if every user is in one Google Workspace organization — worth considering depending on who the users are.
- **Privacy policy** must state that images are sent to Google Vertex AI for processing.
- **APIs to enable:** Drive API; Picker API only if using the Picker.
- **Unresolved:** whether a folder chosen via the Google Picker exposes its contents under `drive.file`. Reports conflict — test with a real account before designing around it.

## Setup checklist

Ordered to avoid the known blockers: Claude cannot be called until an admin enables it, and the OAuth screen needs scopes in place before publishing.

- [ ] Dedicated Google Cloud project with billing
- [ ] Enable Vertex AI API (and Drive API if used)
- [ ] Create app service account, grant `roles/aiplatform.user`
- [ ] As an admin, enable Claude Sonnet 5 in Model Garden (`roles/consumerprocurement.entitlementManager`)
- [ ] Verify no org policy blocks partner models in Model Garden
- [ ] Send a test image to the `eu` endpoint per model; **confirm the host in request logs**
- [ ] Enable Data Access audit logs for Vertex AI
- [ ] Model IDs and endpoint in config, not code
- [ ] OAuth consent screen: sign-in scopes, `drive.file`, privacy policy URL, brand info
- [ ] Publish to leave testing mode
- [ ] Evaluate 50–100 Romanian handwriting samples across both models, then choose

## Open items

Not confirmed; each could change the design.

1. **Claude 5.5 in the EU** — model pages exist, but the residency table did not list them. Check the table *and* Model Garden before use.
2. **Prices** — from third-party listings, not Google's pricing page. Estimates only.
3. **Where Drive stores images** — Vertex EU processing says nothing about Drive's storage region. Check the account's data region if images hold personal data.
4. **Folder pick under `drive.file`** — reports conflict; test it.
5. **Predict-only custom role** — confirm `aiplatform.endpoints.predict` alone suffices for both Gemini and Claude.

## Confidence and provenance

**This is a research note, not verified documentation.** Figures and claims were gathered mostly from search-result excerpts read on **10 October 2026**; only the Vertex AI endpoints page was opened in full. Prices came from third-party listings. Treat every number as indicative and re-confirm in the Cloud console before budgeting or committing to a design.

Note also that Google has renamed Vertex AI to **"Gemini Enterprise Agent Platform"**, so console and documentation use the newer name.

### Sources

- [Claude Sonnet 5 on Google Cloud](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/sonnet-5)
- [Vertex AI data residency](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency)
- [Vertex AI endpoints and multi-region hosts](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations)
- [Vertex AI partner models and required roles](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-partner-models)
- [Gemini 3.8 Flash residency](https://www.spotdev.co.uk/blog/gemini-3-8-flash-workspace-hubspot-uk)
- EU price listings: [Claude](https://www.requesty.ai/eu-new/claude), [Gemini](https://www.requesty.ai/eu-new/gemini)
- [Drive scope tiers](https://docs.unified.to/skills/google-drive-oauth-app/SKILL.md)
- [`drive.file` and picked folders](https://github.com/transloadit/uppy/pull/6385)
- [API key ignoring location](https://github.com/google-gemini/gemini-cli/issues/27984)
