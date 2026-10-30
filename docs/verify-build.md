# Checking that a site serves the code you can read

A web app served by an operator could be swapped for a different one, and a different one could read your keys. Spine's answer is not to ask you to trust the operator: the build is the same files for the same commit wherever it is made, it lists the hash of each file, and anyone can compare a site with their own build of the commit it says it runs. This page is how (requirements `TR-CLI-02`, SECURITY.md **M-40**).

## What the build does

`npm run build` in `web/` ends with `web/scripts/seal-build.mjs`:

- Each script and stylesheet the page loads gets an `integrity="sha384-..."` attribute, so the browser refuses a file that is not the one the page was built with: a cache or CDN in front of the operator, a half-finished deploy. **It does not stop an operator who serves a different page**, who would write the attributes too. The core's worker, the WebAssembly files and lazily loaded chunks are outside what the attribute covers; the content security policy (`script-src 'self'`) and the list below are what cover them.
- `hashes.txt` lists the SHA-256 of every file of the build, one `<hash>  <path>` line each, sorted, in the format `sha256sum -c` reads. The site serves it at `/hashes.txt`. It includes `index.html`, so the integrity attributes are part of what is compared.
- The build fails if any built file names the folder it was built in, since the same commit would then build differently elsewhere. `./scripts/check.sh repro` (a CI job) builds twice and fails if the lists differ.

## Check a site

Get the commit the operator says they run (a tag, or the commit in their release notes), then:

```bash
git checkout <commit>
npm ci && npm run build         # the same Node major as the Dockerfile (22) gives the same files
node scripts/verify-build.mjs https://spine.example.com web/dist
```

It fetches the site's `hashes.txt` and every file in it, compares each served file with its line, and compares that list with the one your build made. It says `ok` only when they all match, and otherwise names each file that differs. Without the second argument it checks only that the site is consistent with itself, which proves nothing about the code.

## What this does and does not give you

- It gives you a second party's word for what the page is: if you, or anyone you trust, builds the commit and gets the same list, the operator is serving code that is in the repository, and the repository is open.
- It does not run when you open the page. A swapped client would not check itself. The check is one you (or a monitor you run, or a person you trust) run from outside, and it only catches a swap that is served to the one who checks. A swap served only to you cannot be seen by anyone else's check, which is the limit of any web client. A native client installed from a store is the other answer, and is not part of the first release.
- The build is reproducible given the lockfile (`npm ci`) and the same Node major. A different Node or operating system can change a file (a native binary is not in the output, but a compiler's output can change between versions); if your list differs from the site's, build in the Docker image (`docker build .`, whose base is pinned by digest) before suspecting the site.
