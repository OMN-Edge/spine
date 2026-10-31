# Releasing

Spine is `0.x` until its first production release. A version is a git tag `vX.Y.Z` that matches `version` in `web/package.json` (the root, `core` and `server` carry the same number); the release workflow refuses a tag that does not.

## Cut a release

1. On a branch: `npm version <X.Y.Z> --workspaces --include-workspace-root --no-git-tag-version`, move the `Unreleased` lines of `CHANGELOG.md` under the new version, and commit. Merge it into `main` by pull request, with the checks green.
2. Tag that commit on `main` and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. Nothing else triggers a release.
3. `.github/workflows/release.yml` runs every check, builds the web app from the tagged commit, attests `hashes.txt` and the build, and publishes a GitHub Release (a pre-release for `v0.*`) with both files.
4. Deploy it: `git checkout vX.Y.Z && ./install.sh -b && sudo systemctl restart spine-web`, then `./scripts/deploy-check.sh vX.Y.Z`, which checks the release's attestation and that the build here is the same list ([verify-build.md](verify-build.md)).

The first time, release `0.1.0-rc.1` before `0.1.0` (a version with a `-` is always a pre-release): the release workflow and `deploy-check.sh` have not been run for real, and a failed trial costs nothing.

## A personal deploy

Build and restart as above, from any commit. The page's footer and `/trust` show the commit, with `-dirty` if the tree had uncommitted changes, so a deploy that is not a release says so.
