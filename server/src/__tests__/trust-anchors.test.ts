import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Fastify from 'fastify';
import { loadTrustAnchors, trustAnchorsDir } from '../trust-anchors.js';
import { trustAnchorRoutes } from '../routes/trust-anchors.js';
import { readSigners } from 'spine-core/ingestion/signatures-cms.js';

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, '../../../core/src/__tests__/fixtures', name)));
const pem = (der: Uint8Array) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;

describe('trust anchors', () => {
  it('reads PEM and DER files from the named directory and nothing else', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spine-anchors-'));
    writeFileSync(path.join(dir, 'a.pem'), pem(fixture('chain-root.der')));
    writeFileSync(path.join(dir, 'b.der'), fixture('chain-root.der'));
    writeFileSync(path.join(dir, 'notes.txt'), 'not a certificate');
    writeFileSync(path.join(dir, 'c.crt'), 'garbage');
    expect(loadTrustAnchors(dir)).toHaveLength(2);
    expect(loadTrustAnchors(null)).toEqual([]);
    expect(loadTrustAnchors(path.join(dir, 'missing'))).toEqual([]);
    expect(trustAnchorsDir({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('are served as base64 and verify a signer with what the route gave', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spine-anchors-'));
    writeFileSync(path.join(dir, 'root.pem'), pem(fixture('chain-root.der')));
    process.env.SPINE_TRUST_ANCHORS_DIR = dir;
    try {
      const app = Fastify();
      await app.register(trustAnchorRoutes);
      const body = (await app.inject({ method: 'GET', url: '/api/trust-anchors' })).json() as { anchors: string[] };
      expect(body.anchors).toHaveLength(1);
      const anchors = body.anchors.map(b64 => new Uint8Array(Buffer.from(b64, 'base64')));
      expect(await readSigners(fixture('signed-chain-good.pdf'), anchors)).toMatchObject([{ name: 'Ana Exemplu', verified: true }]);
    } finally {
      delete process.env.SPINE_TRUST_ANCHORS_DIR;
    }
  });
});
