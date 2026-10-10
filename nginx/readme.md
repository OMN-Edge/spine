# Nginx setup for Spine

Uses the existing bare-metal nginx install from `packages/nginx/`.

## 1. Get the TLS certificate

```bash
cd /path/to/packages/nginx
./nginx-domains.sh cert spine.yourdomain.com
```

This runs certbot and stores the cert at `/etc/letsencrypt/live/spine.yourdomain.com/`.

## 2. Install the Spine site config

```bash
# Replace SPINE_DOMAIN with your actual domain, then copy into place
sed 's/SPINE_DOMAIN/spine.yourdomain.com/g' nginx/spine.conf \
  | sudo tee /etc/nginx/sites-available/spine > /dev/null

sudo ln -sf /etc/nginx/sites-available/spine /etc/nginx/sites-enabled/spine
sudo nginx -t && sudo systemctl reload nginx
```

## 3. Auto-renewal

certbot's renewal cron (installed automatically by certbot) handles cert renewal.
After renewal, reload nginx:

```bash
# Add to /etc/letsencrypt/renewal-hooks/deploy/spine.sh
#!/bin/bash
systemctl reload nginx
```
