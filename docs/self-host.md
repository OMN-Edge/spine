# Self-hosting with Docker Compose

One machine, one domain, three commands. For a Raspberry Pi without Docker, see [setup.md](setup.md) and `install.sh`.

```bash
SPINE_DOMAIN=spine.example.com ./install.sh -e   # writes .env (and relay.env, given a key) with generated secrets; asks for an Anthropic API key
docker compose up -d     # builds the images, starts the app, a daily backup, the HTTPS proxy and, with relay.env, the relay
docker compose exec web node dist/cli.js create-user you@example.com   # prints a password once
```

`install.sh -e` only writes the two files (it runs on a Mac too); to write them by hand, copy `.env.example` to `.env` and set `SESSION_SECRET` (`openssl rand -base64 48`), `SPINE_DOMAIN` and the relay's settings ([relay.md](relay.md)). Point the domain's DNS at the machine, and the relay's name (`relay.<domain>` unless `SPINE_RELAY_DOMAIN` says otherwise) too, and keep ports 80 and 443 open: the proxy (Caddy) gets a Let's Encrypt certificate for each by itself. For a trial on your own computer set `SPINE_DOMAIN=localhost`; Caddy then uses its own certificate, which your browser will warn about once.

## What runs

| Service | What it is | Reachable from |
| --- | --- | --- |
| `proxy` | Caddy: TLS, the security headers of `nginx/spine.conf`, no-store on `/share/` | the internet, ports 80 and 443 |
| `web` | The server and the built web app (`Dockerfile`): accounts, the sealed vault, shares. No parser or OCR: the browser does that | the proxy only |
| `backup` | `backup.js` once a day: a database snapshot and a mirror of the sealed vault; before it, `geoip-update.ts` refreshes the country file the share log reads | nothing |
| `relay` | The relay for model calls (`relay.Dockerfile`, [relay.md](relay.md)), only with `COMPOSE_PROFILES=relay` in `.env`. It reads `.env` and `relay.env`, which holds the provider's key; the server never gets that file | the proxy only, at `SPINE_RELAY_DOMAIN` |

Data lives in Docker volumes: `data` (the database and the files), `backups`, `relay-data` (the relay's daily count), `caddy-data` (certificates). `docker compose down` keeps them; `docker compose down -v` deletes them, records included.

## Operating it

- **Accounts, password resets, two-factor:** `docker compose exec web node dist/cli.js <command>`, the same commands as `npm run cli --` in the readme.
- **Update:** `git pull && docker compose up -d --build`.
- **Backups:** the `backups` volume sits on the same disk as the data, which protects against corruption and a mistaken delete, not against losing the disk. Copy it elsewhere (`docker run --rm -v spine_backups:/b -v "$PWD":/out alpine tar czf /out/backups.tgz -C /b .`), or set `SPINE_BACKUP_DIR` for the `backup` service to a mounted network path. Restoring is described in [SECURITY.md](../SECURITY.md#operational-response).
- **The relay elsewhere** (Cloud Run): leave `COMPOSE_PROFILES` and `SPINE_RELAY_DOMAIN` out of `.env` and set `SPINE_RELAY_URL` to it.
- **Behind your own proxy instead of Caddy:** remove the `proxy` service and publish `web`'s port to your proxy only (and the relay's, at its own hostname). Name your proxy's address in `SPINE_TRUSTED_PROXIES` and make it overwrite `X-Forwarded-For` with the client's address (SECURITY.md **S-31**); without that every visitor shares one rate limit.

## Differences from the nginx setup

- Caddy has no per-address request limit on `/share/` like nginx's `limit_req`; the application's own limits still apply.
- `SPINE_HOST` is `0.0.0.0` inside the private Compose network and nothing but the proxy can reach it, so the rule that the server binds loopback holds for the host.
