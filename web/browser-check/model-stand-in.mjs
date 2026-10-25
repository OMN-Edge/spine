// A relay with a stand-in for the model behind it, for checks that exercise the whole path from the page: the real relay code
// (server/dist/relay) over the accounts store of core, whose model answers every task with the simplest value that fits its schema (server/src/relay/stand-in.ts).
import { createServer } from 'node:http';
import path from 'node:path';

const dist = path.resolve(import.meta.dirname, '../../server/dist/relay');
const { createRelay } = await import(path.join(dist, 'relay.js'));
const { standInClients } = await import(path.join(dist, 'stand-in.js'));
// The relay counts its day in the accounts store, asked for as the server asks for it, not by reaching into the adapter's files.
const { createAccountsStore } = await import(path.resolve(import.meta.dirname, '../../core/dist/store/index.js'));

export async function startRelayWithStandIn({ secret, origin }) {
  const calls = [];
  const { clients } = standInClients();
  const handle = createRelay({
    secret, allowedOrigin: origin, dailyCalls: 1000, usage: createAccountsStore({ adapter: 'sqlite', location: ':memory:' }).usage, maxBodyBytes: 32 * 1024 * 1024,
    clients: () => clients,
    embedder: () => ({ enabled: true, id: 'stand-in:768', dims: 768, embed: async texts => texts.map(() => Float32Array.from({ length: 768 }, (_, i) => (i % 7) + 1)) }),
    log: line => calls.push(line),
  });
  const server = createServer((req, res) => void handle(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}
