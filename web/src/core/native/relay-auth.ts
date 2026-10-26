import { deviceSettings } from './settings';
import { useRelayHooks } from 'spine-core/llm/adapters/relay';

/**
 * How the device reaches the model: through the relay, with a pass the Spine server gives to a signed-in account
 * (server/src/routes/relay.ts, docs/crypto-design.md). The passes are short; one is reused until a minute before it ends.
 */
/** The relay is https. On this machine, for trying one, it may be plain http: the library always writes https, so that one case is put right. */
export const relayFetch: typeof fetch = (input, init) =>
  fetch(typeof input === 'string' ? input.replace(/^https:\/\/(localhost|127\.0\.0\.1)(?=[:/])/, 'http://$1') : input, init);

let pass: { token: string; expiresAt: number } | null = null;

/** Where passes come from: the Spine server, at the page's own address (a worker needs it written out; tests may set it). */
export let tokenUrl = '/api/relay/token';
let tokenMethod = 'GET';
export const useTokenUrl = (url: string, method = 'GET') => { tokenUrl = url; tokenMethod = method; pass = null; };

export async function relayToken(): Promise<string> {
  if (pass && pass.expiresAt - Date.now() > 60_000) return pass.token;
  const res = await fetch(tokenUrl, { method: tokenMethod });
  if (!res.ok) throw Object.assign(new Error('could not get a pass for the model service'), { status: res.status });
  const body = (await res.json()) as { token: string; expires_at: number };
  pass = { token: body.token, expiresAt: body.expires_at };
  return pass.token;
}

/**
 * Takes the server's settings for model calls as the core's own configuration (the core reads its settings from `deviceSettings`, registered with `useSettings`, as the
 * server does). Without a relay the settings stay as they are, and a call that needs a model says it is not set up.
 */
let mail = false;
/** Whether the server tells the owner by mail when a browser asks to be let in. */
export const relayMail = (): boolean => mail;

export async function applyRelayConfig(): Promise<boolean> {
  const res = await fetch('/api/relay/config');
  if (!res.ok) return false;
  const body = (await res.json()) as { env: Record<string, string>; mail?: boolean };
  mail = body.mail === true;
  Object.assign(deviceSettings, body.env);
  useRelayHooks({ tokenProvider: relayToken, fetchImpl: relayFetch });
  return true;
}
