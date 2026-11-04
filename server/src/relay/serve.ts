import { createServer } from 'node:http';
import { loadEmbeddingConfig, loadLlmConfig } from 'spine-core/config.js';
import { createTaskClients, type TaskClients } from 'spine-core/llm/index.js';
import { getEmbedder } from 'spine-core/embedding/index.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { billingOn } from '../billing/config.js';
import { createRelayGate } from '../billing/gate.js';
import { createRelay } from './relay.js';
import { MIN_SECRET_LENGTH } from './token.js';

/**
 * The relay service: what `main.ts` (and the check's `testing/stand-in-relay.ts`) start once they have registered a store and the providers
 * the settings may name. Cloud Run or any host. It is configured only by the environment: the same
 * SPINE_LLM_* and SPINE_EMBEDDING_* settings as the server, and the provider adapter named there does the calling (so Vertex's endpoint,
 * region and project must be stated and a Google API key is refused, as for the server's own calls). The daily allowance per user is counted in the store's `usage`.
 */
/** A count of calls a day: a whole number, 0 for none; anything else gives the default. */
const count = (raw: string | undefined, fallback: number) => (raw !== undefined && raw.trim() !== '' && Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : fallback);

/**
 * The relay's daily allowances: one account (`SPINE_RELAY_DAILY_CALLS`, 500), one share link (`SPINE_RELAY_SHARE_DAILY_CALLS`, 200), one
 * demo visitor (`SPINE_RELAY_DEMO_DAILY_CALLS`, 40) and every demo visitor together (`SPINE_RELAY_DEMO_TOTAL_DAILY_CALLS`, 400). All four are
 * read alike: 0 means none, and there is no unlimited; a large number is the way to say "as many as needed".
 */
export function relayAllowances(env: NodeJS.ProcessEnv = process.env) {
  return {
    dailyCalls: count(env.SPINE_RELAY_DAILY_CALLS, 500),
    dailySharedCalls: count(env.SPINE_RELAY_SHARE_DAILY_CALLS, 200),
    dailyDemoCalls: count(env.SPINE_RELAY_DEMO_DAILY_CALLS, 40),
    dailyDemoTotalCalls: count(env.SPINE_RELAY_DEMO_TOTAL_DAILY_CALLS, 400),
  };
}

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
  // The same for the embeddings: Vertex's endpoint, region and project are checked here, the one process that uses them (the server only
  // passes on whether they are on).
  const embeddings = loadEmbeddingConfig();
  const allowances = relayAllowances();
  // Residency has to be observable (SECURITY.md P8, M-8): say once where the calls go, and what a day allows. No content and no credential in it.
  console.log(JSON.stringify({
    time: new Date().toISOString(), event: 'relay ready', provider: llm.provider, model: llm.model, endpoint: llm.endpoint ?? null, region: llm.region ?? null,
    embeddings: embeddings.adapter === 'none' ? null : { endpoint: embeddings.endpoint ?? null, region: embeddings.region ?? null }, ...allowances,
  }));

  // The daily count lives in the store the environment names (SPINE_STORE, DATA_DIR / SPINE_DB_PATH), chosen as the model provider is. A relay
  // with no database of its own sets SPINE_DB_PATH=:memory:, which counts in this process (run one instance); one that shares the server's
  // database, or a networked adapter, counts across restarts and instances.
  const usage = getAccountsStore().usage;

  const handle = createRelay({
    secret,
    allowedOrigin: need('SPINE_RELAY_ORIGIN'),
    // The demo's calls (SECURITY.md M-39): only the Spine server's SPINE_DEMO_UPLOADS=on gives a pass for them; its two counts bound what they cost.
    ...allowances,
    usage,
    // Plans, when the instance has them (SPINE_BILLING=on); the relay reads the same accounts store the server does.
    gate: billingOn() ? createRelayGate(getAccountsStore) : undefined,
    maxBodyBytes: 32 * 1024 * 1024,
    clients,
    embedder: getEmbedder,
    // One line a call, and never a word of what it carried.
    log: line => console.log(JSON.stringify({ time: new Date().toISOString(), ...line })),
  });

  // Cloud Run sets PORT and needs every interface. On the server's own machine the relay reads the server's .env, whose PORT is the
  // server's, so SPINE_RELAY_PORT comes first, and SPINE_RELAY_HOST=127.0.0.1 keeps it behind the proxy (docs/relay.md).
  const port = Number(process.env.SPINE_RELAY_PORT || process.env.PORT || 8080);
  createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); }).listen(port, process.env.SPINE_RELAY_HOST || '0.0.0.0');
}
