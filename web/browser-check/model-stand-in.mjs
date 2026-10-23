// A relay with a stand-in for the model behind it, for checks that exercise the whole path from the page: the real relay code
// (server/dist/relay), whose "Google" answers every structured call with the simplest value that fits the schema it was asked for.
import { createServer } from 'node:http';
import path from 'node:path';

const dist = path.resolve(import.meta.dirname, '../../server/dist/relay');
const { createRelay } = await import(path.join(dist, 'relay.js'));

/** The simplest value that satisfies a JSON schema. */
export function valueFor(schema, depth = 0) {
  if (!schema || depth > 8) return null;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) return valueFor((schema.anyOf ?? schema.oneOf)[0], depth + 1);
  switch ((Array.isArray(schema.type) ? schema.type[0] : schema.type)?.toLowerCase()) {
    case 'string': return 'sample';
    case 'number': case 'integer': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return Object.fromEntries((schema.required ?? Object.keys(schema.properties ?? {})).map(k => [k, valueFor(schema.properties?.[k], depth + 1)]));
    default: return null;
  }
}

export async function startRelayWithStandIn({ secret, origin, models }) {
  const calls = [];
  const handle = createRelay({
    secret, allowedOrigin: origin, dailyCalls: 1000, maxBodyBytes: 32 * 1024 * 1024, accessToken: async () => 'stand-in-credential',
    targets: models, log: line => calls.push(line),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init.body));
      if (String(url).includes(':embedContent')) return Response.json({ embedding: { values: Array.from({ length: 768 }, (_, i) => (i % 7) + 1) } });
      const declaration = body.tools?.[0]?.functionDeclarations?.[0];
      const parts = declaration ? [{ functionCall: { name: declaration.name, args: valueFor(declaration.parameters) } }] : [{ text: 'A sample answer.' }];
      return Response.json({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
    },
  });
  const server = createServer((req, res) => void handle(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}
