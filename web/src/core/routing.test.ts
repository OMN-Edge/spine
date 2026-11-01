import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { goesToServer } from './client';

/**
 * The page sends a request to the server or to a core by its path (`appFetch`). The server registers no route of records, so every route
 * it does register must be sent to it: a route missing from the list is answered by the core with a 404, and a screen that reads it
 * shows nothing, which is what hid the plan card, the pricing page and the waitlist until a browser was pointed at a real payment sandbox.
 */
const SERVER = path.resolve(__dirname, '../../../server/src');

function serverRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) { if (!['__tests__', '__integration__', 'testing'].includes(name)) walk(file); continue; }
      if (!file.endsWith('.ts')) continue;
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/\.(?:get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'(\/api\/[^']+)'/g)) out.push(m[1]!);
    }
  };
  walk(SERVER);
  return out;
}

describe('which requests go to the server', () => {
  const routes = serverRoutes();

  it('finds the routes it is meant to check', () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(routes).toContain('/api/billing/checkout');
  });

  it('sends every route the server registers to the server, with its parameters filled in', () => {
    const sent = (route: string) => goesToServer(route.replace(/:[A-Za-z_]+/g, 'x1'));
    expect(routes.filter(r => !sent(r))).toEqual([]);
  });

  it('sends a record route to the device’s core', () => {
    for (const url of ['/api/documents', '/api/documents/x1', '/api/share-links', '/api/chat', '/api/emergency', '/api/pages/x1/image']) expect(goesToServer(url)).toBe(false);
  });
});
