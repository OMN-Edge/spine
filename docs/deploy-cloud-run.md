# Deploying on Cloud Run: no machine, no downtime, from one account to a million

The server, the relay and the hourly work run as Cloud Run services and a job; the accounts are in Cloud SQL (Postgres) and the sealed bytes in a bucket. No instance holds anything: any can be replaced, and more added at any moment, which is what lets it grow without a person and be updated without downtime. The configuration is in [deploy/cloud-run/](../deploy/cloud-run/); for one machine with a disk, [deploy-gcp.md](deploy-gcp.md).

```
 browser ──► global load balancer ──► Cloud Run: spine ───┐            (the page, the accounts, the vault, shares)
 (TLS, apex domain, CDN for     │                         ├──► Cloud SQL (Postgres)   rows: accounts, sessions, limits
  the hashed files, Cloud Armor)└──► Cloud Run: spine-relay ┤──► Cloud Storage bucket   sealed bytes: vault objects, shares
                                          │               │
                                          └──► Vertex AI (eu endpoint), as the relay's own service account
 Cloud Scheduler (hourly) ──► Cloud Run job: spine-jobs ──┘            (ended shares, reminders, ended sign-ins)
```

## What the server does so that it can run this way

Each of these is a setting, off by default, so a machine with Caddy or nginx and a disk is unchanged.

| Setting | What it changes | Why an instance has to |
|---|---|---|
| `SPINE_SERVER_HEADERS=on` | The server sets the content security policy, HSTS, `X-Frame-Options`, `nosniff`, the referrer and permissions policies, the no-store on `/share/`, and refuses dot-files. | Here no proxy of ours is in front to do it. |
| `SPINE_TRUSTED_HOPS=2` and `SPINE_EDGE_SECRET` | Takes the client's address from `X-Forwarded-For` by depth: the platform appends the address it saw, so what a client wrote earlier is ignored (2 behind the load balancer). The load balancer also adds the secret as `X-Spine-Edge`, and a request without it has its forwarding headers dropped before anything reads an address, so a client that reached the port some other way cannot choose its own (**S-68**). The server refuses to start with one setting and not the other. | The platform's front end has no address to name in `SPINE_TRUSTED_PROXIES`, and without this every visitor would be one address with one rate limit (SECURITY.md **S-31**). |
| `SPINE_LIMITS=store` | Every limit (sign-in, sign-up, recovery, shares, the per-address ones) is counted in the database, one count for all instances. | Counted in each instance, a limit that guards a password is N times weaker with N instances (**S-66**). |
| `SPINE_JOBS=external` | The server starts no timer; `node dist/jobs.js` does the hourly work once, from a job. | An instance that scales to nothing, or is not given the processor between requests, does not keep time. Every pass is safe to run twice at once. |
| `SPINE_STORE=postgres`, `SPINE_OBJECTS=gcs` | The rows are in Postgres and the bytes in a bucket; with both, the process writes no file, closes no directory and mirrors no backup (`local-files.ts`, held by a test). | State on an instance's disk is state a replacement does not have. |
| `GET /healthz` and `SIGTERM` | The server answers the platform's checks only after its database is open, and on `SIGTERM` finishes the requests in flight before it ends (the relay does the same). | A rollout moves traffic only to instances that are up, and takes none from a request half done. |

## Before you start

A Google Cloud project with billing, `gcloud` signed in, and a domain whose records you can set. Set once: `PROJECT_ID`, `REGION=europe-west4`, and the name `INSTANCE` for the database. Every resource goes in an EU region, so the data and the model calls stay in the EU.

## Steps

1. **The services, and a place for the images.**

   ```bash
   gcloud config set project $PROJECT_ID
   gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com \
     cloudscheduler.googleapis.com compute.googleapis.com aiplatform.googleapis.com cloudbuild.googleapis.com
   gcloud artifacts repositories create spine --repository-format=docker --location=$REGION
   ```

2. **The images,** from a checkout, tagged with the commit they were built from. The server's image carries the country file for the share log (a disk does not exist to keep it on).

   ```bash
   TAG=$(git rev-parse --short HEAD)
   gcloud builds submit --region=$REGION --config=deploy/cloud-run/cloudbuild.yaml \
     --substitutions=_TAG=$TAG,_COMMIT=$(git rev-parse HEAD) .
   ```

3. **The database.** Postgres, in a high-availability configuration with automated backups and point-in-time recovery (the backup of the rows: `backup.ts` makes none for Postgres), in the same region. Spine's own tables are made on the first start and added to by later ones.

   ```bash
   gcloud sql instances create $INSTANCE --database-version=POSTGRES_16 --region=$REGION --availability-type=REGIONAL \
     --tier=db-custom-2-7680 --storage-auto-increase --backup-start-time=02:00 --enable-point-in-time-recovery \
     --deletion-protection --edition=ENTERPRISE
   gcloud sql databases create spine --instance=$INSTANCE
   gcloud sql users create spine --instance=$INSTANCE --password="$(openssl rand -hex 24)"
   ```

   Keep that password for the next step and nowhere else; it is hex so that it can stand in an address as it is. **Connections:** every instance holds up to `SPINE_DATABASE_POOL` (the files set 4 for the server and 3 for the relay) and Cloud Run adds instances as load rises, so the instance count times the pool, with the relay's and the job's, must stay under what the database allows (`SHOW max_connections`, and keep a fifth free for you). The files' `maxScale: 40` at those pools is about 280. To go higher, put Cloud SQL's managed connection pooling, or PgBouncer, between them and the database, and raise `maxScale` with it.

4. **The bucket for the sealed bytes,** as in [deployment-gcp.md](deployment-gcp.md#where-the-sealed-bytes-go-cloud-run-and-other-hosts-with-no-disk): an EU location, uniform bucket-level access, public access prevented, and versioning or soft delete on (that is its backup).

   ```bash
   gcloud storage buckets create gs://$BUCKET --location=eu --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update gs://$BUCKET --versioning
   ```

5. **Two service accounts, with nothing in common.** The app's may use the bucket, the database and its secrets; the relay's may call Vertex, the database and its secrets, and cannot touch the bucket. That is the separation **M-35** describes, which a machine with one identity cannot have (**S-65**).

   ```bash
   for sa in spine-app spine-relay; do gcloud iam service-accounts create $sa; done
   APP=spine-app@$PROJECT_ID.iam.gserviceaccount.com; RELAY=spine-relay@$PROJECT_ID.iam.gserviceaccount.com
   gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member=serviceAccount:$APP --role=roles/storage.objectAdmin
   for member in $APP $RELAY; do
     gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$member --role=roles/cloudsql.client
   done
   gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$RELAY --role=roles/aiplatform.user
   ```

6. **The secrets,** in Secret Manager, each readable by the account that needs it. The database address is `postgres://spine:PASSWORD@/spine?host=/cloudsql/PROJECT_ID:europe-west4:INSTANCE` (the socket Cloud Run mounts, encrypted by the connector).

   ```bash
   mk() { printf %s "$2" | gcloud secrets create "$1" --data-file=-; }
   mk spine-session-secret "$(openssl rand -base64 48)"
   mk spine-relay-secret "$(openssl rand -base64 48)"
   mk spine-edge-secret "$(openssl rand -base64 48)"   # the load balancer adds it to every request (step 9)
   mk spine-database-url "postgres://spine:PASSWORD@/spine?host=/cloudsql/$PROJECT_ID:$REGION:$INSTANCE"
   mk spine-brevo-key "..."                       # the mail provider's API key
   gcloud secrets create spine-fair-use --data-file=fair-use.json   # the hidden ceilings (docs/billing.md); an empty {} to use the built-in ones
   for s in spine-session-secret spine-edge-secret spine-database-url spine-brevo-key spine-fair-use; do
     gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$APP --role=roles/secretmanager.secretAccessor
   done
   for s in spine-relay-secret spine-database-url; do
     gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$RELAY --role=roles/secretmanager.secretAccessor
   done
   gcloud secrets add-iam-policy-binding spine-relay-secret --member=serviceAccount:$APP --role=roles/secretmanager.secretAccessor
   ```

   The relay gets none of the server's secrets (`SESSION_SECRET`, the mail key, the payment keys): a test fails if its files name one (**S-62**).

7. **Fill in the files and deploy.** In `deploy/cloud-run/` replace `PROJECT_ID`, `INSTANCE`, `TAG`, `BUCKET` and `CHANGE`, and the domain if it is not `spinevault.eu`; then:

   ```bash
   gcloud run services replace deploy/cloud-run/app.service.yaml --region=$REGION
   gcloud run services replace deploy/cloud-run/relay.service.yaml --region=$REGION
   gcloud run jobs replace deploy/cloud-run/jobs.job.yaml --region=$REGION
   ```

   Both services take traffic from the load balancer only (`ingress: internal-and-cloud-load-balancing`), which is what makes the hop count safe: nothing can reach the port with a header of its own.

8. **The hourly job.** Cloud Scheduler starts it with an identity that may run it and nothing else.

   ```bash
   gcloud iam service-accounts create spine-scheduler
   gcloud run jobs add-iam-policy-binding spine-jobs --region=$REGION --member=serviceAccount:spine-scheduler@$PROJECT_ID.iam.gserviceaccount.com --role=roles/run.invoker
   gcloud scheduler jobs create http spine-jobs --location=$REGION --schedule="7 * * * *" --http-method=POST \
     --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/spine-jobs:run" \
     --oauth-service-account-email=spine-scheduler@$PROJECT_ID.iam.gserviceaccount.com
   ```

9. **The load balancer, the certificate and the names.** A global external Application Load Balancer, with a serverless network endpoint group for each service, one URL map that sends `spinevault.eu` to the app and `relay.spinevault.eu` to the relay, a Google-managed certificate for both names, and a redirect from port 80. The apex domain is why it is a load balancer and not a domain mapping. Turn Cloud CDN on for the app's backend with the cache mode that follows the origin's headers (`USE_ORIGIN_HEADERS`): only the built files, which the server marks `public, max-age=31536000, immutable`, are then kept; the API and a share are never cached (`no-store`, or no header). Put Cloud Armor on both backends for a first line against floods. Give the app's backend service the secret as a custom request header, `gcloud compute backend-services update BACKEND --global --custom-request-header="X-Spine-Edge:$(gcloud secrets versions access latest --secret=spine-edge-secret)"`, so that every request it forwards carries the proof the server asks for. Then the DNS records for both names go to the load balancer's address. Follow Google's "Set up a global external Application Load Balancer with Cloud Run" for the commands; the choices above are the ones that matter to Spine.

10. **Check it.**

    ```bash
    curl -sI https://spinevault.eu/ | grep -iE 'content-security-policy|strict-transport|x-frame'
    curl -s https://spinevault.eu/healthz
    gcloud run jobs execute spine-jobs --region=$REGION --wait
    gcloud run jobs executions list --job=spine-jobs --region=$REGION --limit=1
    gcloud run services logs read spine-relay --region=$REGION --limit=20 | grep 'relay ready'
    ```

    The headers must be there, the job's last execution must have succeeded, and the relay's `relay ready` line must name `aiplatform.eu.rep.googleapis.com`.

    **Confirm the client's address, once.** Make a request from your own connection and read its `remoteAddress` in the server's request log (`gcloud run services logs read spine --region=$REGION --limit=20`). It must be yours. If it is Google's, either the header is not reaching the server (the log then says a request reached the port without `X-Spine-Edge`) or the hop count is too small (every visitor would be one address with one limit); fix the header first, then raise the count by one and look again. Never go past the number that shows your own address, because a count that is too large believes an entry the client wrote. Then send the same request with an `X-Spine-Edge` and an `X-Forwarded-For` of your own making: the address in the log must still be yours.

    **The first account.** With `SPINE_REGISTRATION=open`, sign up on the site; the people in `SPINE_ADMIN_EMAILS` can approve others. The operator's commands (`list-users`, `approve-user`, `delete-user`, [CLAUDE.md](../CLAUDE.md)) run from a checkout with the server's settings and the database reached through the Cloud SQL Auth Proxy (`cloud-sql-proxy PROJECT_ID:$REGION:$INSTANCE --port 5432`, and `SPINE_STORE=postgres SPINE_DATABASE_URL=postgres://spine:PASSWORD@127.0.0.1:5432/spine`).

## Updating with no downtime

A deploy makes a new revision; the old one keeps serving until the new one is up, and the traffic moves.

```bash
gcloud run services replace deploy/cloud-run/app.service.yaml --region=$REGION   # with the new TAG in it: all the traffic moves once the revision is up
```

To try it before anyone is on it, deploy the image with `gcloud run deploy spine --image=... --no-traffic --tag=next --region=$REGION` (the rest of the configuration is kept, and Cloud Run gives the revision an address of its own), look at it, then move the traffic in steps: `gcloud run services update-traffic spine --to-tags=next=10`, then 50, then `--to-latest`. A bad one is undone by moving the traffic back to the previous revision, which is still there. What keeps it from being felt:

- **Instances are never none** (`minScale: 2`), and a new one takes no traffic until `/healthz` answers, which is after its database is open.
- **A stopping instance finishes what it is doing** (`SIGTERM`, above), up to the seconds Cloud Run allows; a model call that is longer than that is cut and the device tries again.
- **Two versions run at once during a rollout, so a change to the database must work for both.** Spine's tables are made when an instance starts (`CREATE TABLE IF NOT EXISTS`, under a lock so instances starting together do not collide) and a column is added with a default. That is the only kind of change a rollout can carry: a new table, or a new column with a default, in one release. Renaming or removing something takes two: the first stops using it, the second removes it once no revision of the first is left. A change that cannot be made that way (CLAUDE.md: "a schema change other than a new defaulted column needs an empty database") is not made while a database holds accounts, and is a project of its own with a migration.
- **The relay is updated the same way,** on its own schedule: the two share only the database and the secret.

## From one account to a million

What grows by itself, and what you grow.

- **The services** add instances as requests arrive, up to `maxScale`, and the load balancer spreads them. An instance holds nothing, so adding one is free of risk.
- **The bucket** has no size to plan for.
- **The database is the one thing that is a number.** Every request that signs someone in or touches an account reads or writes it; the limited ones (sign-in, sign-up, shares) also write a row to count. Raise its machine size with the load (Cloud SQL resizes with a short failover, which the high-availability pair makes brief), watch its CPU, connections and storage, and pool its connections when `maxScale` times the pool passes what it allows (step 3). Past a size one primary does not suit, the reads that are only reads (the legal texts, a share's metadata) are the ones to move to a replica; there is no code for it yet, and no sign that it is the first thing to be needed.
- **The hourly job** does one pass over what has ended and is safe to run twice at once. Its file allows ten minutes: raise `timeoutSeconds` if the first pass after a long stop runs over.
- **Model cost** is the relay's and the provider's, bounded per account by the plan, the daily allowance and the hidden ceilings ([relay.md](relay.md), [billing.md](billing.md)); Vertex's own quotas bound it from outside. Raise them with Google before a launch, not after.
- **Mail** is Brevo's: its plan's sending limit, and the app's own caps (`SPINE_MAIL_MAX_PER_HOUR`, `SPINE_SIGNUPS_MAX_PER_HOUR`), which are counted for all instances together.

Every size above is arithmetic with a limit named in step 3 and in the files; measure with real traffic before relying on one.

## What this setup gives up

- **The country of a share's opener is as old as the image,** since the file is baked in. Rebuild monthly (a new tag, a new revision, the same steps), or leave countries unknown.
- **A limited request costs a write.** Sign-in is the one that matters, and it is already a password hash.
- **The reads a sealed object makes at once** (`SPINE_MAX_CONCURRENT_READS`, the hourly bytes of a share) are counted in each instance, not across them: they bound what one instance spends on one source, and `maxScale` bounds how many instances there are.
- **Three Google-side behaviours are the platform's and not this repository's:** the size of a request it accepts (the vault's parts and a share's copy are sent in pieces; check the limit for your region against the largest part your settings allow), the time it gives an instance to stop, and the load balancer's own timeout (raise it for the relay's backend to the service's 300 seconds).
