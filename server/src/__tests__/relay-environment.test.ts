import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_ONLY_SECRETS, serverSecretsHeld } from '../relay/serve.js';

/** SECURITY.md S-62: the relay's process holds nothing that only the server uses, and says so when it does. */
describe('the secrets the relay does not need', () => {
  it('names the payment provider’s key and webhook secret beside the session secret and the mail key', () => {
    expect([...SERVER_ONLY_SECRETS].sort()).toEqual(['BREVO_API_KEY', 'PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET', 'SESSION_SECRET']);
  });

  it('reports the ones that are set, by name and never by value, and not the blank ones', () => {
    const env = { SESSION_SECRET: '', BREVO_API_KEY: ' ', PADDLE_API_KEY: 'pdl_live_apikey_value', PADDLE_WEBHOOK_SECRET: 'whsec_value', SPINE_RELAY_SECRET: 'x'.repeat(40) };
    expect(serverSecretsHeld(env)).toEqual(['PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET']);
    expect(JSON.stringify(serverSecretsHeld(env))).not.toContain('value');
    expect(serverSecretsHeld({})).toEqual([]);
  });

  // The unit and the container give the relay the server's .env and then take these out; the list there must be this one.
  it('are all taken out of the relay’s environment by its systemd unit and its container', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const unit = fs.readFileSync(path.join(root, 'systemd/spine-relay.service'), 'utf8');
    const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
    const relay = compose.slice(compose.indexOf('\n  relay:'), compose.indexOf('\n  proxy:'));
    const unset = /^UnsetEnvironment=(.*)$/m.exec(unit)![1].split(/\s+/);
    for (const name of SERVER_ONLY_SECRETS) {
      expect(unset, `systemd unit: ${name}`).toContain(name);
      expect(relay, `compose relay: ${name}`).toMatch(new RegExp(`${name}: ""`));
    }
  });
});
