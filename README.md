# Spine

Personal medical document archive. Upload PDFs and scans, let AI extract and index the content, review it, and share a read-only link with a doctor when needed.

Your records are read, searched and kept on your own device, in your browser. The server, which runs on a Raspberry Pi, holds only your account and sealed pieces of your records that it cannot open (see [docs/key-hierarchy.md](docs/key-hierarchy.md)). Model calls go through a relay that stores and logs nothing.

## What it does

- Upload PDFs, scans, Word documents, text files and photos; a merged PDF is split into its documents, and each is read for its date, provider, type, summary, fields and lab values
- Every extracted field links back to the page it came from, and you review, correct or override anything the AI got wrong
- Full-text search, lab values charted over time against their reference range, a doctors directory, and a library of tags, providers and tests to tidy
- Expiring, revocable, read-only share links for a doctor, scoped to everything, a tag, documents you pick, a date range or an episode, with no account or app needed
- Ask your records questions in a chat that only reads
- Related documents, episodes and care chains, suggested from the data and confirmed by you
- The interface in English, Romanian, French and German, and documents translated on demand
- Records for several people, an emergency card, and export and restore as a zip
- A demo on the front page with invented records, in the visitor's browser, with no account and nothing saved

## Stack

| | |
|---|---|
| Server | Node.js + Fastify: accounts, the vault of sealed objects, sealed shares, the relay's pass; serves the React build. It holds no record |
| Device | React + Vite + Tailwind CSS; the core (the shared `spine-core` package) in a Web Worker, with libsodium for the keys |
| Database | SQLite: in WebAssembly on the device (the records), a file on the server (accounts only) |
| Parsing | On the device: PDF.js reads the PDF's text layer, Tesseract.js reads scans, and, optionally, a vision model reads pages the others could not |
| AI | Anthropic or Vertex AI behind the relay, set by its configuration |
| Web server | nginx with Let's Encrypt, or Caddy in Docker Compose |

## Run it

On a Debian or Raspberry Pi OS machine that the domain (and `relay.<domain>`, for the relay) already points at:

```bash
sudo SPINE_DOMAIN=spine.yourdomain.com ./install.sh -a
```

It installs the dependencies, writes `.env` with generated secrets, builds, starts the services and the relay, and sets up nginx with Let's Encrypt. Then create your account: `cd server && npm run cli -- create-user you@example.com`. With Docker instead: `./install.sh -e && docker compose up -d` ([docs/self-host.md](docs/self-host.md)). Each step on its own, what to decide first and what to do when the server refuses to start are in [docs/setup.md](docs/setup.md).

To work on the code: [docs/developing.md](docs/developing.md).

## Documentation

**Run an instance**

- [docs/self-host.md](docs/self-host.md): `docker compose up -d` on one machine, with HTTPS
- [docs/setup.md](docs/setup.md): the full install guide for a Raspberry Pi
- [docs/relay.md](docs/relay.md): the relay that runs model calls, and how to deploy it
- [docs/deployment-gcp.md](docs/deployment-gcp.md): Vertex AI as an inference provider, EU residency, IAM
- [docs/billing.md](docs/billing.md): plans and payment
- [docs/operator-checklist.md](docs/operator-checklist.md): what the person who runs an instance must do or confirm, which the software cannot check
- [docs/verify-build.md](docs/verify-build.md): checking that a site serves the build of a given commit

**Understand it**

- [ARCHITECTURE.md](ARCHITECTURE.md): where the code runs, trust boundaries, and the detail pages on interfaces, the pipeline and the data
- [SECURITY.md](SECURITY.md): security principles, implemented controls, the open gaps and how to report a vulnerability
- [docs/key-hierarchy.md](docs/key-hierarchy.md): the key hierarchy and trust boundaries, who can see what ([docs/crypto-design.md](docs/crypto-design.md) is the build plan)
- [docs/requirements.md](docs/requirements.md): what it must do (the `FR-`, `TR-` and `CR-` IDs cited around the repository)
- [docs/configuration.md](docs/configuration.md): every environment variable

**Change it**

- [docs/developing.md](docs/developing.md): from a clone to a change that passes the checks
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute; the repository is canonical on GitHub, and a deployed instance redirects `/source`, `/docs` and `/security` to it (set `SPINE_REPO_URL`)
- [docs/structure-rules.md](docs/structure-rules.md): what "clean" means here, as rules a test checks
- [docs/design-decisions.md](docs/design-decisions.md): the decisions the code depends on, by area
- [docs/testing.md](docs/testing.md) and [docs/scenarios.md](docs/scenarios.md): every check, and what each user flow is tested by
- [docs/releasing.md](docs/releasing.md) and [CHANGELOG.md](CHANGELOG.md)

**Legal and compliance**

- [docs/legal/](docs/legal): the privacy notice, terms and purpose text a person agrees to
- [docs/compliance/](docs/compliance/README.md): drafts for the lawyer (DPIA, record of processing, breach procedure)

## Credits

Countries in a share link's access log come from the [ip-location-db](https://github.com/sapics/ip-location-db) “user-country” database, in the public domain ([PDDL](https://opendatacommons.org/licenses/pddl/1-0/)), which its maintainers build daily from the regional internet registries' published statistics, the Route Views and RIPE RIS routing archives and operators' geofeeds. Spine downloads it to `data/geoip/` (`server/src/geoip-update.ts`).

The interface is set in [Inter](https://rsms.me/inter/) and, on the front page, [IBM Plex Mono](https://github.com/IBM/plex), both under the [SIL Open Font License 1.1](https://openfontlicense.org), through the `@fontsource` packages; the text a device writes into a PDF uses [DejaVu Sans](https://dejavu-fonts.github.io).

## Licence

GNU Affero General Public License v3.0 only (AGPL-3.0-only), see [LICENSE](LICENSE). Anyone who runs a modified version as a network service must offer its users the corresponding source. This is software for holding medical records, provided without warranty: read [SECURITY.md](SECURITY.md) before putting real records on an instance. Whoever runs an instance is the controller of its data.
