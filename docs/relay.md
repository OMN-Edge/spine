# The relay for model calls

A device (the browser) reads documents itself, so it is the one that sends text and page images to the model. It cannot hold Spine's provider credential, so it sends those calls to a small service, the relay, which holds the credential and runs them through the provider adapter you configured (Vertex or Anthropic; a new provider is one adapter file in `server/src/llm/adapters/`). The device speaks a neutral protocol (`core/src/relay/protocol.ts`): a task name and messages in, a parsed result, a message or a stream of chunks out, and texts to vectors for embeddings. This page says what the relay does and does not do, how to deploy it, and what the operator must still do in the cloud console. The security entry is [SECURITY.md](../SECURITY.md) **M-35**.

## What it is

`server/src/relay/` in this repository, started with `node dist/relay/main.js` (`relay.Dockerfile`). It is configured by the environment only. The Spine server reads some of the same names (to tell devices which models are offered and whether features are on) but calls no model itself:

| Variable | What it is |
| --- | --- |
| `SPINE_RELAY_SECRET` | At least 32 random characters, the same on the relay and on the Spine server. Signs the passes the server gives devices. |
| `SPINE_LLM_PROVIDER` | `vertex` or `anthropic`: the provider the relay calls, with that adapter's own settings (`ANTHROPIC_API_KEY`, or the Vertex ones below). Not `relay`. |
| `SPINE_LLM_ENDPOINT`, `SPINE_LLM_REGION`, `SPINE_LLM_PROJECT` | For Vertex: stated, never defaulted; residency is a property of the endpoint (e.g. `aiplatform.eu.rep.googleapis.com`, `eu`). |
| `SPINE_LLM_MODEL`, `SPINE_LLM_MODELS` | The models that may be called (`id` or `id=Label`; `id|region=Label` for a model that is served in another region). Anything else is refused. |
| `SPINE_EMBEDDINGS=vertex`, `SPINE_EMBEDDING_MODEL`, `_REGION`, `_PROJECT`, `_ENDPOINT` | The embedding model, if used: the relay's embedder, whichever adapter that is. |
| `SPINE_RELAY_ORIGIN` | The address the app is served from (`https://spine.example`), the only origin the browser may call the relay from. |
| `SPINE_RELAY_DAILY_CALLS` | Calls one account may make a day (default 500). Counted in the store (next row). |
| `SPINE_RELAY_DEMO_DAILY_CALLS`, `SPINE_RELAY_DEMO_TOTAL_DAILY_CALLS` | For the demo's uploads, which the Spine server gives passes for only with `SPINE_DEMO_UPLOADS=on`: calls one visitor's address may make a day (default 40) and calls every visitor of the demo together may make a day (default 400), the bound on what people with no account cost. The address reaches the relay only as a keyed hash. `0` allows none (SECURITY.md **M-39**). |
| `SPINE_RELAY_SHARE_DAILY_CALLS` | Calls one share link may make a day, for what its recipient translates or asks (default 200), counted apart from the owner's account. |
| `SPINE_STORE`, `DATA_DIR`, `SPINE_DB_PATH` | The store the relay counts in, chosen as the server's is. It records only a number a day per account (table `model_usage`), so the relay may share the server's database, have one of its own on a volume, or set `SPINE_DB_PATH=:memory:` to count in the process (**run one instance** then). The SQLite adapter is a file, so instances that share a count must share the file; a networked adapter would not need that. |
| `PORT` | The port to listen on (Cloud Run sets it). |

The Spine server needs `SPINE_RELAY_URL` (the relay's https address) and `SPINE_RELAY_SECRET`. Without them a device cannot call a model and says so. Docker Compose passes `SPINE_RELAY_URL` to the proxy so the page's content security policy allows it (`nginx/spine.conf` gets it from `install.sh -n`).

## What it does and does not do

- It checks the pass, the path (one of Spine's tasks or the embedding call), the shape of the body, that the model is one it offers, the size and the account's daily allowance; then it runs the task through its provider adapter with its own credential. A tool the device names is a declaration given to the model, never run by the relay. Nothing else of the device's goes on.
- It **stores nothing and logs no content**: one line a call with the task, model, status, request size and time, and once at startup a line (`relay ready`) with the provider, model, endpoint and region it will call. A provider's own error text is not passed back, because it may quote what was sent.
- It **can see** everything that passes through it, in plaintext. Say "does not store or log content" in product text, never "cannot see". An enclave relay with attestation (Google Cloud Confidential Space) would remove that and is a later step.

## Deploying on Cloud Run

```bash
gcloud run deploy spine-relay \
  --source . --region europe-west4 \
  --service-account spine-relay@PROJECT.iam.gserviceaccount.com \
  --max-instances 1 --min-instances 0 --concurrency 20 --timeout 300 \
  --allow-unauthenticated \
  --set-env-vars SPINE_LLM_PROVIDER=vertex,SPINE_LLM_ENDPOINT=aiplatform.eu.rep.googleapis.com,SPINE_LLM_REGION=eu,SPINE_LLM_PROJECT=PROJECT,SPINE_LLM_MODEL=gemini-3.8-flash,SPINE_RELAY_ORIGIN=https://spine.example \
  --set-secrets SPINE_RELAY_SECRET=spine-relay-secret:latest
```

(`--source .` uses `relay.Dockerfile` if you name it with `--dockerfile`, or build and push the image yourself.) Notes:

- **Unauthenticated at the platform level**: the pass is the authentication; Cloud Run's own IAM check would stop a browser. The service account has only the Vertex AI User role.
- **One instance** while the store is `:memory:` (the usual Cloud Run setting): raise `--max-instances` only after the count is in a store every instance reaches.
- **Region**: an EU region for the service itself, as the requirements say. Request logging is metadata only; do not enable request-body logging.
- Put the service's address in `SPINE_RELAY_URL` on the Spine server and in `SPINE_RELAY_ORIGIN`'s counterpart: the relay allows the app's origin, and the app's content security policy allows the relay's.

## Before the first real user (the operator's, in the Google Cloud console)

From the requirements, "Vertex AI zero-retention setup": disable data caching on the project; request the abuse-monitoring exception (prompt logging); leave request-response logging disabled; no Grounding with Google Search or Maps; regional EU endpoints only; test the model on handwritten pages (Gemini Pro as a fallback for low-confidence pages). None of that is done by code in this repository.
