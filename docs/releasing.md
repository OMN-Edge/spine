# Releasing

Spine is `0.x` until its first production release. A version is a git tag `vX.Y.Z` that matches `version` in `web/package.json` (the root, `core` and `server` carry the same number); the release workflow refuses a tag that does not.

## Before a release: the security review

No release is cut until what changed since the last one has been through the security review. Automated checks run on every change (CI: the tests, the dependency audit, gitleaks, semgrep, the two real-browser checks, the reproducible build); this is the part a person does, with the method of [threats.md](threats.md):

1. **What changed.** `git diff <last tag>..HEAD`: the routes, settings, tables, dependencies and paths out of the host it adds or changes.
2. **The threat model.** A change that adds something to protect, someone who might attack it, or a place where data crosses from one party to another is added to the trust boundaries in [SECURITY.md](../SECURITY.md) and to [threats.md](threats.md).
3. **The areas it touches**, each checked against the enforcement checklist at the end of SECURITY.md and the matching chapter of OWASP ASVS 5.0 (and the OWASP Top 10 for LLM Applications for a change to the assistant or a prompt), with a verdict written down for each.
4. **What it finds** is fixed before the release, with a test that fails without the fix, or entered in SECURITY.md's known gaps with the reason it can wait.
5. **The documents** the change touches (SECURITY.md, ARCHITECTURE.md, threats.md, the legal texts, the screens) are read against the code for what the change made untrue.
6. **After deploying**, `./scripts/host-report.sh` on the host and `./scripts/host-report.sh outside <domain>` from elsewhere, read against the previous run.

The release's lines in `CHANGELOG.md` say it was reviewed and which areas the review covered.

## Cut a release

1. On a branch: `npm version <X.Y.Z> --workspaces --include-workspace-root --no-git-tag-version`, move the `Unreleased` lines of `CHANGELOG.md` under the new version, and commit. Merge it into `main` by pull request, with the checks green.
2. Tag that commit on `main` and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. Nothing else triggers a release.
3. `.github/workflows/release.yml` runs every check, builds the web app from the tagged commit, attests `hashes.txt` and the build, and publishes a GitHub Release (a pre-release for `v0.*`) with both files.
4. Deploy it: `git checkout vX.Y.Z && ./install.sh -b && sudo systemctl restart spine-web`, then `./scripts/deploy-check.sh vX.Y.Z`, which checks the release's attestation and that the build here is the same list ([verify-build.md](verify-build.md)).

The first time, release `0.1.0-rc.1` before `0.1.0` (a version with a `-` is always a pre-release): a failed first run of the release workflow then costs nothing.

## A personal deploy

Build and restart as above, from any commit. The page's footer and `/trust` show the commit, with `-dirty` if the tree had uncommitted changes, so a deploy that is not a release says so.
