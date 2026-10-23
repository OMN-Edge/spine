# The relay for model calls

A device (the browser) reads documents itself, so it is the one that sends text and page images to the model. It cannot hold Spine's Google credential, so it sends those calls to a small service, the relay, which holds the credential and forwards them. This page says what the relay does and does not do, how to deploy it, and what the operator must still do in the cloud console. The security entry is [SECURITY.md](../SECURITY.md) **M-35**.

## What it is

`server/src/relay/` in this repository, started with `node dist/relay/main.js` (`relay.Dockerfile`). It is configured by the environment only, with the same values the Spine server reads for its own model calls, so one set describes both:

| Variable | What it is |
| --- | --- |
| `SPINE_RELAY_SECRET` | At least 32 random characters, the same on the relay and on the Spine server. Signs the passes the server gives devices. |
| `SPINE_LLM_PROVIDER` | `vertex` (the relay forwards to Vertex AI only). |
| `SPINE_LLM_ENDPOINT`, `SPINE_LLM_REGION`, `SPINE_LLM_PROJECT` | Stated, never defaulted: residency is a property of the endpoint (e.g. `aiplatform.eu.rep.googleapis.com`, `eu`). |
| `SPINE_LLM_MODEL`, `SPINE_LLM_MODELS` | The models that may be called; each may have its own region. Anything else is refused. |
| `SPINE_EMBEDDINGS=vertex`, `SPINE_EMBEDDING_MODEL`, `_REGION`, `_PROJECT`, `_ENDPOINT` | The embedding model, if used. |
| `SPINE_RELAY_ORIGIN` | The address the app is served from (`https://spine.example`), the only origin the browser may call the relay from. |
| `SPINE_RELAY_DAILY_CALLS` | Calls one account may make a day (default 500). Counted in the process: **run one instance**. |
| `PORT` | The port to listen on (Cloud Run sets it). |

The Spine server needs `SPINE_RELAY_URL` (the relay's https address) and `SPINE_RELAY_SECRET`. Without them a device cannot call a model and says so. Docker Compose passes `SPINE_RELAY_URL` to the proxy so the page's content security policy allows it (`nginx/spine.conf` gets it from `install.sh -n`).

## What it does and does not do

- It checks the pass, the path (a model, project and region it was configured with, and a call Spine makes), the size and the account's daily allowance; then it sends the body to the stated endpoint with its own credential and nothing else of the device's.
- It **stores nothing and logs no content**: one line a call with the model, method, status, request size and time.
- It **can see** everything that passes through it, in plaintext. Say "does not store or log content" in product text, never "cannot see". An enclave relay with attestation (Google Cloud Confidential Space) would remove that and is a later step.

## Deploying on Cloud Run

```bash
gcloud run deploy spine-relay \
  --source . --region europe-west4 \
  --service-account spine-relay@PROJECT.iam.gserviceaccount.com \
  --max-instances 1 --min-instances 0 --concurrency 20 --timeout 300 \
  --allow-unauthenticated \
  --set-env-vars SPINE_LLM_PROVIDER=vertex,SPINE_LLM_ENDPOINT=aiplatform.eu.rep.googleapis.com,SPINE_LLM_REGION=eu,SPINE_LLM_PROJECT=PROJECT,SPINE_LLM_MODEL=gemini-3.5-flash,SPINE_RELAY_ORIGIN=https://spine.example \
  --set-secrets SPINE_RELAY_SECRET=spine-relay-secret:latest
```

(`--source .` uses `relay.Dockerfile` if you name it with `--dockerfile`, or build and push the image yourself.) Notes:

- **Unauthenticated at the platform level**: the pass is the authentication; Cloud Run's own IAM check would stop a browser. The service account has only the Vertex AI User role.
- **One instance**: the daily allowance is counted in memory. Raise `--max-instances` only after moving the count somewhere shared.
- **Region**: an EU region for the service itself, as the requirements say. Request logging is metadata only; do not enable request-body logging.
- Put the service's address in `SPINE_RELAY_URL` on the Spine server and in `SPINE_RELAY_ORIGIN`'s counterpart: the relay allows the app's origin, and the app's content security policy allows the relay's.

## Before the first real user (the operator's, in the Google Cloud console)

From the requirements, "Vertex AI zero-retention setup": disable data caching on the project; request the abuse-monitoring exception (prompt logging); leave request-response logging disabled; no Grounding with Google Search or Maps; regional EU endpoints only; test the model on handwritten pages (Gemini Pro as a fallback for low-confidence pages). None of that is done by code in this repository.
