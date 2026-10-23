# Self-hosting with Docker Compose

One machine, one domain, three commands. For a Raspberry Pi without Docker, see [setup.md](setup.md) and `install.sh`.

```bash
cp .env.example .env     # set SESSION_SECRET (openssl rand -base64 48) and SPINE_DOMAIN, plus a model provider
docker compose up -d     # builds the images, starts the app, a daily backup and the HTTPS proxy
docker compose exec web node dist/cli.js create-user you@example.com   # prints a password once
```

Point the domain's DNS at the machine and keep ports 80 and 443 open: the proxy (Caddy) gets a Let's Encrypt certificate by itself. For a trial on your own computer set `SPINE_DOMAIN=localhost`; Caddy then uses its own certificate, which your browser will warn about once.

## What runs

| Service | What it is | Reachable from |
| --- | --- | --- |
| `proxy` | Caddy: TLS, the security headers of `nginx/spine.conf`, no-store on `/share/` | the internet, ports 80 and 443 |
| `web` | The server and the built web app (`Dockerfile`), with poppler and Tesseract | the proxy only |
| `backup` | `backup.js` once a day: a database snapshot and a mirror of the originals | nothing |

Data lives in Docker volumes: `data` (the database and the files), `backups`, `caddy-data` (certificates). `docker compose down` keeps them; `docker compose down -v` deletes them, records included.

## Operating it

- **Accounts, password resets, two-factor:** `docker compose exec web node dist/cli.js <command>`, the same commands as `npm run cli --` in the readme.
- **Update:** `git pull && docker compose up -d --build`.
- **Backups:** the `backups` volume sits on the same disk as the data, which protects against corruption and a mistaken delete, not against losing the disk. Copy it elsewhere (`docker run --rm -v spine_backups:/b -v "$PWD":/out alpine tar czf /out/backups.tgz -C /b .`), or set `SPINE_BACKUP_DIR` for the `backup` service to a mounted network path. Restoring is described in [SECURITY.md](../SECURITY.md#operational-response).
- **Behind your own proxy instead of Caddy:** remove the `proxy` service and publish `web`'s port to your proxy only. Name your proxy's address in `SPINE_TRUSTED_PROXIES` and make it overwrite `X-Forwarded-For` with the client's address (SECURITY.md **S-31**); without that every visitor shares one rate limit.

## Differences from the nginx setup

- Caddy has no per-address request limit on `/share/` like nginx's `limit_req`; the application's own limits still apply.
- `SPINE_HOST` is `0.0.0.0` inside the private Compose network and nothing but the proxy can reach it, so the rule that the server binds loopback holds for the host.
