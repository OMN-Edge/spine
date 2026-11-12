# Deploying on Google Cloud: one VM

One Compute Engine virtual machine in an EU region runs the Docker Compose stack of [self-host.md](self-host.md) (the proxy, the server, the daily backup and the relay), and calls Vertex AI at the `eu` endpoint as the VM's own service account. The configuration for `spinevault.eu` is in [deploy/gcp/](../deploy/gcp/). Nothing here has been run against a real project: read each command before you run it, and check the result of each step.

## Why a VM and not Cloud Run

Cloud Run suits the relay alone ([relay.md](relay.md)) and nothing else here, for three reasons that come from the code, not from Cloud Run:

- **The security headers are the proxy's, not the server's.** The content security policy, HSTS, `X-Frame-Options` and the no-store on `/share/` are set by Caddy (`Caddyfile`) and nginx (`nginx/spine.conf`). The server sets none, so on Cloud Run, which has no proxy of ours, a page would be served without them.
- **The client's address cannot be told.** The server believes `X-Forwarded-For` only from the addresses in `SPINE_TRUSTED_PROXIES`, never a wide range (SECURITY.md **S-31**). Cloud Run's front end has no fixed address to name, so every visitor would arrive as one address and share one rate limit, and a share's log would show one country.
- **With plans on, the relay reads the server's accounts database** (`createRelayGate` in `server/src/billing/gate.ts`), so the two must reach the same one. Cloud Run would need Cloud SQL and the bucket of [deployment-gcp.md](deployment-gcp.md) for the sealed bytes, which is a bigger and costlier setup than one disk.

Putting the app on Cloud Run is a project, not a configuration: the headers set by the server when no proxy is in front, and a way to say that the last address in `X-Forwarded-For` is the client's when the host is one that appends it. Until then, the VM.

## What it costs and where it runs

An `e2-medium` (2 vCPU, 4 GB) with a 50 GB balanced disk and a static address is in the order of 30 to 40 euros a month; check the calculator, which is the source. Vertex is billed by use and is separate. Put every resource in `europe-west4` (the Netherlands) so that the data and the model calls stay in the EU.

## Steps

Set once: `PROJECT_ID=your-project`, `REGION=europe-west4`, `ZONE=europe-west4-a`.

1. **A project with billing, and the services.**

   ```bash
   gcloud config set project $PROJECT_ID
   gcloud services enable compute.googleapis.com aiplatform.googleapis.com
   ```

2. **A service account for the VM that may call Vertex and nothing else.**

   ```bash
   gcloud iam service-accounts create spine-vm --display-name="Spine VM"
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:spine-vm@$PROJECT_ID.iam.gserviceaccount.com" --role=roles/aiplatform.user
   ```

3. **The address, the firewall and the machine.** The firewall opens 80 and 443 only; ssh goes through `gcloud compute ssh`, which opens its own path.

   ```bash
   gcloud compute addresses create spine-ip --region=$REGION
   gcloud compute firewall-rules create spine-web --allow=tcp:80,tcp:443 --target-tags=spine-web
   gcloud compute instances create spine --zone=$ZONE --machine-type=e2-medium \
     --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=50GB --boot-disk-type=pd-balanced \
     --address=spine-ip --tags=spine-web --shielded-secure-boot \
     --service-account=spine-vm@$PROJECT_ID.iam.gserviceaccount.com --scopes=cloud-platform
   gcloud compute addresses describe spine-ip --region=$REGION --format='value(address)'
   ```

4. **DNS** at the registrar of `spinevault.eu`: an A record for `spinevault.eu` and one for `relay.spinevault.eu`, both to the address printed above. Caddy gets a certificate for each by itself once they resolve, so wait for them before step 6. The checkout page (`pay.spinevault.eu`, [billing.md](billing.md)) is served from an origin of its own and is not on this machine.

5. **Docker and the code on the machine.**

   ```bash
   gcloud compute ssh spine --zone=$ZONE
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER   # then log out and in
   git clone https://github.com/OMN-Edge/spine.git && cd spine
   ```

6. **The two files, and the start.** Copy `deploy/gcp/env.example` to `.env` and `deploy/gcp/relay.env.example` to `relay.env`, fill in every line that says `CHANGE` (generate the secrets with `openssl rand -base64 48`), set the file modes to 600, and start.

   ```bash
   cp deploy/gcp/env.example .env && cp deploy/gcp/relay.env.example relay.env && chmod 600 .env relay.env
   nano .env relay.env
   docker compose build --build-arg SPINE_COMMIT=$(git rev-parse HEAD)
   docker compose up -d
   curl -f https://relay.spinevault.eu/healthz
   docker compose exec web node dist/cli.js create-user you@example.com
   ```

   The relay's log has a `relay ready` line naming the endpoint it will call: it must say `aiplatform.eu.rep.googleapis.com` (`docker compose logs relay`).

7. **Backups off the machine.** The backup service writes into a volume on the same disk. Schedule snapshots of the disk, which are the copy that survives losing it:

   ```bash
   gcloud compute resource-policies create snapshot-schedule spine-daily --region=$REGION \
     --max-retention-days=14 --daily-schedule --start-time=02:00
   gcloud compute disks add-resource-policies spine --zone=$ZONE --resource-policies=spine-daily
   ```

   A snapshot taken mid-write is crash-consistent, which a SQLite file in its own write-ahead log survives; the backup service's `VACUUM INTO` copy is the consistent one. Try a restore once from each before you rely on them (SECURITY.md, "Operational response").

## Outside the machine

- **Brevo:** the sending domain `spinevault.eu` with SPF, DKIM and DMARC records at the registrar, a verified sender `notices@spinevault.eu`, the API key. The mail's mark is served from `https://spinevault.eu/icons/`, so the site must be up for it to show.
- **Vertex AI:** the settings of [relay.md](relay.md), "Before the first real user", and Claude, if used, enabled in Model Garden by an administrator.
- **Paddle:** [billing.md](billing.md); uncomment the billing block of `.env` only when every value is there, and restart (`docker compose up -d`). **Before that, the relay must read the server's database:** with plans on it asks the accounts store what each account may do, and `compose.yaml` gives it a file of its own (`relay-data`, `SPINE_DB_PATH`), where no account exists. Give it the server's `data` volume and drop that variable, or put both on Postgres (`SPINE_STORE=postgres`); try a read of a document with a test account before the first customer.
- **Addresses:** `security@spinevault.eu` (in `SECURITY.md` and `nginx/security.txt`, which only the nginx setup serves) and `privacy@spinevault.eu` (`SPINE_OPERATOR_CONTACT`) must exist before anyone writes to them.

## Updating

```bash
git pull && docker compose build --build-arg SPINE_COMMIT=$(git rev-parse HEAD) && docker compose up -d
```
