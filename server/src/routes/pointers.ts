import type { FastifyInstance } from 'fastify';

/** The repository's address as a base with no trailing slash, or null where the setting is empty or is not an http(s) address (nothing is redirected to anything else). */
export function repoBase(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * `/source`, `/docs` and `/security`: links the app, the store listings and the docs publish go through this domain, so the repository host can change without breaking
 * them (requirements TR-OSS-05). nginx/spine.conf does the same where nginx is in front; where it is not (Caddy, Cloud Run) the app would answer these paths with its own
 * shell, so the server redirects them itself, from `SPINE_REPO_URL`. With no address set there are no redirects.
 */
export async function pointerRoutes(app: FastifyInstance) {
  const base = repoBase(process.env.SPINE_REPO_URL);
  if (!base) return;
  const pointers: Record<string, string> = {
    '/source': base,
    '/docs': `${base}/tree/main/docs`,
    '/security': `${base}/blob/main/SECURITY.md`,
  };
  for (const [path, target] of Object.entries(pointers)) {
    app.get(path, async (_req, reply) => reply.redirect(target, 302));
  }
}
