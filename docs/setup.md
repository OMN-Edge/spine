# Setup guide

From a fresh machine to a running instance. Allow an hour, most of it waiting for DNS and the certificate. The short version is in the [readme](../readme.md); this adds what you need to decide, and what to do when something refuses to start.

Steps marked **untested** were written from the scripts and provider documentation and have not been run end to end. Everything else was run, though not on a fresh machine.

## 0. Decide first

| Question | Options | Default |
|---|---|---|
| Who gets accounts? | **You, from the command line**, or **anyone, by signing up** (needs email, step 5) | You |
| Where does inference run? | **Anthropic** (simplest, API key) or **Vertex AI in the EU** (needs a Google Cloud project, [docs/deployment-gcp.md](deployment-gcp.md)) | Anthropic |
| May page images leave the machine? | **No**: typed PDFs work fully; scans and handwriting are read by local OCR only and may come out poorly. **Yes, for pages that need it**: `hybrid` | No |

The third is the one to think about. With the default, nothing but short text excerpts (the text of each page pair, to decide boundaries, and each document's full text, to extract it) goes to the model. With `hybrid`, a page image is sent only when the page has no text layer **and** local OCR could not read it confidently. If your data must stay in the EU, use Vertex at an `eu` endpoint: the Anthropic adapter has no such commitment.

## 1. What you need

- A Linux machine with `apt` (Raspberry Pi OS bookworm or Debian/Ubuntu). A Pi is enough.
- **Python 3.11, 3.12 or 3.13**, with its `venv` package. The sidecar's `unstructured` (0.27) does not install on 3.14 or newer. If the default `python3` is 3.14, name another one for the build in step 2 (`PYTHON=python3.13 ./install.sh -b`).
- A **domain name** pointing at the machine (an `A` record), and, if it is at home, your router forwarding **ports 80 and 443** to it. Let's Encrypt needs 80 to issue the certificate.
- An **API key** for your provider (step 3).
- `git` and `sudo`.

## 2. Install

```bash
git clone <your repository URL> spine && cd spine

sudo ./install.sh -d      # Node (22, 24 or 26), Python 3, poppler, tesseract + Romanian pack
PYTHON=python3.13 ./install.sh -b    # builds web and server, creates the Python venv (a few minutes on a Pi)
```

`-d` does **not** install nginx or certbot; step 6 does.

## 3. Configure

```bash
cp .env.example .env
nano .env
```

The minimum:

```bash
ANTHROPIC_API_KEY=sk-ant-...             # or configure Vertex instead, see below
SESSION_SECRET=<output of: openssl rand -base64 48>
SPINE_DOMAIN=spine.yourdomain.com
```

`SESSION_SECRET` must be at least 32 characters and not the placeholder; the installer and the server both refuse otherwise. **Do not change it later without reading this**: it signs sessions *and* encrypts everyone's two-factor seeds, so changing it signs everyone out and breaks authenticator codes (recovery codes still work; SECURITY.md S-21).

### Vertex AI instead of Anthropic

Complete the [GCP checklist](deployment-gcp.md#setup-checklist) first, then:

```bash
SPINE_LLM_PROVIDER=vertex
SPINE_LLM_MODEL=gemini-3.8-flash
SPINE_LLM_ENDPOINT=aiplatform.eu.rep.googleapis.com
SPINE_LLM_REGION=eu
SPINE_LLM_PROJECT=your-gcp-project
GOOGLE_APPLICATION_CREDENTIALS=/etc/spine/vertex-sa.json   # service-account key file
```

There are no defaults on purpose. The service **refuses to start if `GOOGLE_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY` is set anywhere in its environment**, because that silently sends requests to a global endpoint. After the first real call, check the provider's request logs to confirm the EU host was used. **Untested** against a live project.

### Letting scans and handwriting be read (optional)

```bash
SPINE_PARSER=hybrid
SPINE_MULTIMODAL_ENABLED=true
```

Both lines are required; either alone is refused. `hybrid` reads a page's text layer first and sends only the pages that have none to the model, as images.

- **Local OCR is optional.** By default `hybrid` tries Tesseract before the model, which needs `tesseract-ocr` and the packs in `SPINE_OCR_LANGS` (default `ron+eng`; `-d` installs Romanian; others with `sudo apt install tesseract-ocr-<lang>`). `SPINE_OCR=off` skips it and sends a page with no text layer straight to the model. `SPINE_PARSER=ocr` is OCR with no model at all: it needs neither switch, but it reads handwriting poorly.
- **The same switch allows two other things.** Signature stamps in a PDF are read as small cropped pictures (the doctor's name, specialty and professional code), never the whole page. Photos (JPEG or PNG) are accepted at upload and read by the model; without the switch a photo is refused.
- **The thresholds are first guesses.** After a few uploads, look at the `page routed` lines in the log and adjust (see `.env.example`).

### Backups (recommended)

By default backups land beside `data/`, which protects against mistakes but not a dead SD card. Point them elsewhere:

```bash
SPINE_BACKUP_DIR=/mnt/usb/spine-backup
```

and add that path to `ReadWritePaths=` in `systemd/spine-backup.service` before step 4.

## 4. Start the services

```bash
sudo ./install.sh -s
```

This installs and starts `spine-web` (port 3000, loopback only), `spine-ingestion` (port 8000, loopback only) and a daily backup timer. It stops with a list of problems if the secret is unsafe. Check:

```bash
systemctl is-active spine-web spine-ingestion spine-backup.timer
journalctl -u spine-web -n 30
```

The log should contain `llm provider ready` (the provider, model and endpoint it resolved) and `parser ready` with `imageEgress: false`, unless you enabled `hybrid`.

## 5. Create accounts

**From the command line** (always works, needs no email):

```bash
cd server
npm run cli -- create-user you@example.com   # prints a password once; change it in Account
```

Add `--password-stdin` to choose the password (12 characters or more).

**Or let people sign up.** This needs a mail provider; the server refuses `open` registration without one. With [Brevo](https://www.brevo.com) (**untested** against a live account):

1. Create an account. The free plan allows 300 emails a day.
2. Under *Settings → Senders, Domains, IPs → Domains*, add your domain and publish the DNS records Brevo gives you. DKIM is the one that matters; without it mail may be sent from Brevo's own domain or land in spam.
3. Create an **API key** (not the SMTP key, which is a different credential).
4. In `.env`:

   ```bash
   SPINE_REGISTRATION=open
   SPINE_MAILER=brevo
   BREVO_API_KEY=xkeysib-...
   SPINE_MAIL_SENDER="Account Notices <notices@yourdomain.com>"
   ```

   The sender name is visible in the recipient's inbox and to Brevo: your company or product name is fine, and a more neutral one reveals less. The links in the mail point at `SPINE_DOMAIN`.
5. `sudo systemctl restart spine-web`, then sign up once yourself and follow the link.

Without a mailer, a user who forgets their password gets a one-time link from you: `npm run cli -- reset-link them@example.com`.

## 6. HTTPS and nginx

Spine needs any nginx, and a certificate at `/etc/letsencrypt/live/<domain>/`. `sudo ./install.sh -n` does two things:

1. If a folder `../packages/nginx` exists next to `spine`, it **runs** `nginx-domains.sh cert <domain>` from it (as a separate command, not sourced). That script gets the Let's Encrypt certificate with certbot. If the folder is missing, the installer prints a warning and carries on.
2. It writes Spine's own site config from `nginx/spine.conf` with your domain filled in, enables it and reloads nginx.

So the packages repository is optional: it is the author's way to build nginx and obtain the certificate. Use it, or do those parts yourself.

**With the packages repository**, cloned next to `spine`:

```bash
# from the directory that contains spine/
git clone https://gitlab.com/alexcocinda/packages.git
cd packages/nginx
./install.sh -v 1.28.0 -d          # builds nginx from source and installs its dependencies
sudo apt-get install -y certbot    # the package uses certbot but does not install it
cd ../../spine
sudo ./install.sh -n
```

The nginx version is the stable one the package's readme names; check it for a newer one.

**Without it** (**untested** on a fresh machine), use the distribution's nginx and do the same by hand:

```bash
sudo apt-get install -y nginx certbot
DOMAIN=spine.yourdomain.com
sudo certbot certonly --standalone -d "$DOMAIN" \
  --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx"
sed "s/SPINE_DOMAIN/$DOMAIN/g" nginx/spine.conf | sudo tee /etc/nginx/sites-available/spine >/dev/null
sudo ln -sf /etc/nginx/sites-available/spine /etc/nginx/sites-enabled/spine
sudo nginx -t && sudo systemctl reload nginx
```

Either way, certbot renews on its own timer. Check from another machine:

```bash
curl -sI https://spine.yourdomain.com | head -3          # 200 or a redirect, valid certificate
curl -s  https://spine.yourdomain.com/api/auth/options    # JSON about registration
```

## 7. First use

Open `https://<your domain>`, sign in, and:

1. **Account → Two-factor sign-in → Set up.** Scan the QR code with an authenticator app, enter the first code, and save the ten recovery codes somewhere safe. It is optional, per user, and worth doing on any instance reachable from the internet.
2. **Upload** a PDF and watch it split into documents. Review the extracted fields.
3. The language switcher is in the top bar. A document in another language is translated when you open it, and the result is kept; `SPINE_TRANSLATION=off` stops that (see `.env.example`), because translating sends the document's extracted text and your notes to the model provider.
4. If a scan came out wrong and you enabled `hybrid`, open it and use **Read again → Read page with AI** (or **Read whole document**).
5. **Share links** creates an expiring link for a doctor, scoped to everything, a tag (picked from a dropdown), documents you pick from a list, or a date range. The recipient needs no account and gets the timeline, the document pages and the trends, read-only; the page images (scans) only if you tick **Include scans** for that link, which is off by default because a scan shows the patient's ID number and phone.
6. **Library** tidies the tags, providers and tests the AI extracted (rename, merge, remove), beside **Doctors**.
7. **Upload → Export everything** downloads a zip of your whole archive; dropping that zip on Upload (here or on another instance) restores it without the AI. **Export** on a document page does the same for one document. Keep exports as private as the archive: they hold all of it.

## 8. Keeping it running

```bash
# after pulling new code
./install.sh -b && sudo systemctl restart spine-web          # add spine-ingestion if it changed

journalctl -u spine-web -f                                    # logs
sudo systemctl start spine-backup                             # a backup now, instead of waiting for the timer
```

- **Test a restore once**, before you need one: [SECURITY.md, Operational response](../SECURITY.md#operational-response).
- **Do not load real documents and then update across a schema change** other than a new column with a default, which is added when the database is opened. There is no migration runner yet, and an older-shaped database is refused at startup (it tells you how many records it holds). Look at the history of `server/src/store/sqlite/schema.sql` for changes before updating, and take a backup first.
- `sudo systemctl status` for any unit, and `npm run cli -- list-users` to see accounts.

## When it will not start

The server checks its configuration before it does anything else and lists every problem.

| Message mentions | Cause |
|---|---|
| `SESSION_SECRET` | Missing, under 32 characters, or the placeholder |
| `SPINE_REGISTRATION=open` / `SPINE_MAILER` | Open signup needs a mailer; Brevo also needs `BREVO_API_KEY`, `SPINE_MAIL_SENDER` and `SPINE_DOMAIN` |
| `SPINE_MULTIMODAL_ENABLED` | `multimodal` or `hybrid` chosen without the second switch |
| tesseract / language pack | `hybrid` without `tesseract-ocr` or a pack in `SPINE_OCR_LANGS` |
| `GOOGLE_API_KEY` and similar | One is set in the environment; unset it (Vertex only) |
| `SPINE_LLM_ENDPOINT` / region / project | Vertex needs all three stated |
| outdated database | Left over from an older shape; the message says whether it is safe to delete |
| `pip install` fails on `unstructured` during `-b` | Built with Python 3.14 or newer; use 3.11, 3.12 or 3.13 (step 1) |
| uploads fail immediately | `spine-ingestion` is down: `journalctl -u spine-ingestion`. With `hybrid` the sidecar is required, and the upload fails rather than guessing |
| certificate issuance fails | DNS not pointing here yet, or ports 80/443 not forwarded |
