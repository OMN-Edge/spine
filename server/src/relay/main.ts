import { createServer } from 'node:http';
import { GoogleAuth } from 'google-auth-library';
import { createRelay } from './relay.js';
import { relayTargets } from './targets.js';
import { MIN_SECRET_LENGTH } from './token.js';

/**
 * The relay's process (`node dist/relay/main.js`), for Cloud Run or any host. It is configured only by the environment: the same SPINE_LLM_* and
 * SPINE_EMBEDDING_* settings as the server (endpoint, region and project stated, nothing defaults, as for the server's own model calls), and refuses to start on anything that could send
 * calls elsewhere. Run one instance: the daily allowance per user is counted in memory.
 */
const need = (name: string): string => {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const secret = need('SPINE_RELAY_SECRET');
if (secret.length < MIN_SECRET_LENGTH) throw new Error(`SPINE_RELAY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
const present = ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'].filter(n => (process.env[n] ?? '') !== '');
if (present.length > 0) throw new Error(`${present.join(', ')} is set, which can send calls to the global endpoint; remove it and use the service account`);

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const handle = createRelay({
  secret,
  targets: relayTargets(),
  allowedOrigin: need('SPINE_RELAY_ORIGIN'),
  dailyCalls: Number(process.env.SPINE_RELAY_DAILY_CALLS ?? 500) || 500,
  maxBodyBytes: 32 * 1024 * 1024,
  accessToken: async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error('no access token');
    return token;
  },
  // One line a call, and never a word of what it carried.
  log: line => console.log(JSON.stringify({ time: new Date().toISOString(), ...line })),
});

createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); }).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
