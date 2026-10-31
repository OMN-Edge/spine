import { RunnableLambda } from '@langchain/core/runnables';
import { useAccountsStore } from '../store.js';
import { serveRelay } from '../relay/serve.js';
import { standInClients, useStandInProviders } from './stand-in.js';
import { registerLlmProvider } from 'spine-core/llm/index.js';

// Scratch: the check's relay, but a translation is a real one (each text marked with the language and the model takes a second), so the
// device's cache can be seen to work or not. Not committed.
useAccountsStore();
useStandInProviders();
registerLlmProvider('stand-in', () => {
  const { clients } = standInClients();
  const text = (input: unknown): string => {
    const last = Array.isArray(input) ? input[input.length - 1] : input;
    const c = (last as { content?: unknown })?.content ?? last;
    return typeof c === 'string' ? c : JSON.stringify(c);
  };
  (clients as Record<string, unknown>).translation = RunnableLambda.from(async (input: unknown) => {
    const prompt = text(input);
    const target = prompt.match(/into (\w+)\./)?.[1] ?? '??';
    const json = prompt.split('Record (JSON):\n')[1]?.split('\n\nRules:')[0] ?? '{}';
    const b = JSON.parse(json);
    await new Promise(r => setTimeout(r, Number(process.env.TRY_DELAY ?? 1500)));
    const t = (s: string | null) => (s === null || s === undefined ? null : `${target}[${s}]`);
    return {
      source_language: 'en', title: t(b.title), summary: t(b.summary), notes: t(b.notes),
      fields: (b.fields ?? []).map((f: { id: string; label: string | null; value: string }) => ({ id: f.id, label: t(f.label), value: t(f.value) })),
      measurements: (b.measurements ?? []).map((m: { id: string; name: string }) => ({ id: m.id, name: t(m.name) })),
      doctors: (b.doctors ?? []).map((d: { id: string; specialty: string | null }) => ({ id: d.id, specialty: t(d.specialty) })),
    };
  });
  return clients;
});
serveRelay();
