# Nginx setup for Spine

The site config is `spine.conf`, a template: `sudo ./install.sh -n` (from the repository root) fills in the domain, the relay's address for the page's content security policy, the optional repository redirects and `security.txt`, installs it and reloads nginx. [docs/setup.md](../docs/setup.md#6-https-and-nginx) has the full steps, with and without the author's `packages/nginx` helper, which only obtains the certificate.

Do not copy `spine.conf` by hand with a single `sed` of the domain: its other placeholders (`SPINE_RELAY_URL`, `SPINE_REPO_URL`) would stay in the file, and the page could not call the relay.

After a certificate renewal nginx has to be reloaded; add a deploy hook for it:

```bash
# /etc/letsencrypt/renewal-hooks/deploy/spine.sh
#!/bin/bash
systemctl reload nginx
```
