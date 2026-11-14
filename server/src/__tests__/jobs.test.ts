import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { JOBS, jobsAreExternal, runJobs } from '../jobs.js';
import { healthRoutes } from '../routes/health.js';

describe('the work done on a clock', () => {
  it('is nine passes, each named', () => {
    expect(JOBS.map(j => j.name)).toEqual([
      'removing ended shares', 'reminding about cards', 'mailing due reminders', 'removing ended sign-ins', 'removing unconfirmed accounts', 'removing ended limit windows',
      'mailing the reminders and the trial summaries', 'watching the AI budget', 'refreshing the country file',
    ]);
  });

  it('runs every pass once, and a pass that fails is said and does not stop the others', async () => {
    const ran: string[] = [];
    const said: string[] = [];
    const failed = await runJobs((message, detail) => said.push(`${message} ${detail.err}`), [
      { name: 'first', run: async () => { ran.push('first'); } },
      { name: 'second', run: async () => { ran.push('second'); throw new Error('the database was away'); } },
      { name: 'third', run: async () => { ran.push('third'); } },
    ]);
    expect(ran).toEqual(['first', 'second', 'third']);
    expect(failed).toBe(1);
    expect(said).toEqual(['second failed the database was away']);
  });

  it('is the server’s own unless the deployment says something outside runs it', () => {
    expect(jobsAreExternal({})).toBe(false);
    expect(jobsAreExternal({ SPINE_JOBS: 'internal' })).toBe(false);
    expect(jobsAreExternal({ SPINE_JOBS: 'external' })).toBe(true);
  });
});

describe('the answer a platform asks for before it sends traffic', () => {
  it('is ok, from the process, kept by no cache', async () => {
    const app = Fastify({ logger: false });
    await app.register(healthRoutes);
    const res = await app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok\n');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
