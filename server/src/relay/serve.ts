import { createServer } from 'node:http';
import { loadLlmConfig } from 'spine-core/config.js';
import { createTaskClients, type TaskClients } from 'spine-core/llm/index.js';
import { getEmbedder } from 'spine-core/embedding/index.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { createRelay } from './relay.js';
import { MIN_SECRET_LENGTH } from './token.js';

/**
 * The relay service: what `main.ts` (and the check's `testing/stand-in-relay.ts`) start once they have registered a store and the providers
 * the settings may name. Cloud Run or any host. It is configured only by the environment: the same
 * SPINE_LLM_* and SPINE_EMBEDDING_* settings as the server, and the provider adapter named there does the calling (so Vertex's endpoint,
 * region and project must be stated and a Google API key is refused, as for the server's own calls). The daily allowance per user is counted in the store's `usage`.
 */
export function serveRelay(): void {
  const need = (name: string): string => {
    const v = (process.env[name] ?? '').trim();
    if (!v) throw new Error(`${name} is required`);
    return v;
  };

  const secret = need('SPINE_RELAY_SECRET');
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`SPINE_RELAY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);

  const llm = loadLlmConfig();
  if (llm.provider === 'relay') throw new Error('SPINE_LLM_PROVIDER=relay would make the relay call itself; name the provider it should use');
  const made = new Map<string, TaskClients>();
  /** The models offered, each built once; the default when no model is named. */
  function clients(model: string | undefined): TaskClients | null {
    const id = model || llm.model;
    const choice = llm.models.find(c => c.id === id);
    if (!choice) return null;
    let have = made.get(id);
    if (!have) {
      have = createTaskClients({ ...llm, model: id, ...(choice.region ? { region: choice.region, endpoint: choice.endpoint } : {}) });
      made.set(id, have);
    }
    return have;
  }
  clients(undefined); // a bad provider setting stops the process here and not at the first call
  // Residency has to be observable (SECURITY.md P8, M-8): say once where the calls go. No content and no credential in it.
  console.log(JSON.stringify({ time: new Date().toISOString(), event: 'relay ready', provider: llm.provider, model: llm.model, endpoint: llm.endpoint ?? null, region: llm.region ?? null }));

  // The daily count lives in the store the environment names (SPINE_STORE, DATA_DIR / SPINE_DB_PATH), chosen as the model provider is. A relay
  // with no database of its own sets SPINE_DB_PATH=:memory:, which counts in this process (run one instance); one that shares the server's
  // database, or a networked adapter, counts across restarts and instances.
  const usage = getAccountsStore().usage;

  /** A count of calls; 0 is a count (none), and a value that is not a whole number gives the default. */
  const count = (raw: string | undefined, fallback: number) => (raw !== undefined && Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : fallback);
  const handle = createRelay({
    secret,
    allowedOrigin: need('SPINE_RELAY_ORIGIN'),
    dailyCalls: Number(process.env.SPINE_RELAY_DAILY_CALLS ?? 500) || 500,
    dailySharedCalls: Number(process.env.SPINE_RELAY_SHARE_DAILY_CALLS ?? 200) || 200,
    // The demo's calls (SECURITY.md M-39): only the Spine server's SPINE_DEMO_UPLOADS=on gives a pass for them; these bound what they cost.
    dailyDemoCalls: count(process.env.SPINE_RELAY_DEMO_DAILY_CALLS, 40),
    dailyDemoTotalCalls: count(process.env.SPINE_RELAY_DEMO_TOTAL_DAILY_CALLS, 400),
    usage,
    maxBodyBytes: 32 * 1024 * 1024,
    clients,
    embedder: getEmbedder,
    // One line a call, and never a word of what it carried.
    log: line => console.log(JSON.stringify({ time: new Date().toISOString(), ...line })),
  });

  createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); }).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
}
