# Developing Spine

From a clone to a change that passes the checks. To run an instance for real, see [setup.md](setup.md); to know what a change is judged against, read the documents under "Read first" below.

## Set up

You need Node.js 22 or later and `git`. A browser with Chrome is only needed for the two real-browser checks.

```bash
git clone <your repository URL> spine && cd spine
npm ci                  # one install at the root for the three workspaces: core, server, web
SPINE_DOMAIN=localhost ./install.sh -e   # writes .env with generated secrets; an existing file is left alone
npm run build           # core first (the server and the web app use its output), then the server and the web app
```

`-e` needs a domain name and takes `localhost` for local work. The model settings (`SPINE_RELAY_URL`, `SPINE_RELAY_SECRET`, and the provider key on the relay) are only needed to read a document with a model; everything else works without them. See [relay.md](relay.md) for a relay on your own machine.

## Run it

Two terminals:

```bash
cd server && npm run dev    # Fastify on port 3000, restarted when a file changes; reads ../.env
cd web && npm run dev       # Vite; sends /api and /share to port 3000
```

Open the address Vite prints. Create an account first (`cd server && npm run cli -- create-user you@example.com`, which prints a password once), or use the demo on the front page, which needs no account. Records are made and kept in the browser's core, so changes to `core/` show after a reload of the page; changes to `server/` restart the server.

## Check a change

| Command | When |
|---|---|
| `npm test -w spine-core`, `npm test -w spine-server`, `npm test -w spine-web` | Every change. Seconds, no model is ever called |
| `npm run typecheck -w spine-core -w spine-server` | Every change |
| `./scripts/check.sh all` | Before you send it. This is what CI runs: tests, typecheck, dependency audit, gitleaks, semgrep (`brew install gitleaks semgrep` for the scans) |
| `cd web && npm run check:browser && npm run check:app` | A change to the device, the vault, sync, sharing or anything structural; needs `npm run build` first and Chrome |
| `npm run test:integration -w spine-server` | After changing a prompt, a tool, the pipeline or the model; it calls the real model in `.env` |

[testing.md](testing.md) says what each check answers and which file holds which test.

## Read first

1. [ARCHITECTURE.md](../ARCHITECTURE.md): where the code runs, the trust boundaries, and the detail pages under [architecture/](architecture/README.md) for the store, the model, the pipeline and the data.
2. [SECURITY.md](../SECURITY.md): the numbered principles. A change is judged against them and the checklist at the end. Read it before touching routing, auth, share links, storage, providers or static serving.
3. [structure-rules.md](structure-rules.md): what "clean" means, as rules a test checks.
4. [design-decisions.md](design-decisions.md): the decisions the code depends on, by area. Read the entry for the area you are changing.
5. [configuration.md](configuration.md): every environment variable and what it does.

## Where things are

`core/` is everything the device's core runs, and the server's tests too; `server/` is only what the server runs; `web/` is the React app and the device's host for the core. The directory-by-directory layout is in [CLAUDE.md](../CLAUDE.md#repo-layout).

## Habits that keep the documents true

[CONTRIBUTING.md](../CONTRIBUTING.md) lists them. The short form: a sentence is a claim, so change the sentence in the same commit as the behaviour; a screen string needs its three translations; a changed legal text needs a raised version; a fix comes with a test that fails without it.
