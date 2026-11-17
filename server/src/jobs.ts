import path from 'node:path';
import { remindDue } from './routes/reminders.js';
import { remindCardReviews, sweepShares } from './routes/shared.js';
import { sweepSessions } from './sessions.js';
import { sweepUnverified } from './accounts.js';
import { refreshCountryFile } from './geoip-update.js';
import { getAccountsStore } from 'spine-core/store/index.js';

/**
 * The work that is done on a clock and not on a request: ended shares are deleted, a card nobody has looked at for a year is reminded, due follow-up
 * reminders are mailed, ended sign-ins and accounts that never confirmed their address are removed. Every pass is safe to run more than once at the
 * same time (a claim in the database says who mails or deletes what, `markReminded` and `claimDueReminders`), so any number of instances may run it.
 *
 * Where it runs is the deployment's choice (`SPINE_JOBS`): `internal` (the default) is the server's own hourly timers, right for a machine that is
 * always on; `external` starts none, and something outside runs `node dist/jobs.js` hourly, a Cloud Run job that a scheduler starts (docs/deploy-cloud-run.md),
 * because an instance that scales to nothing, or is not given the processor between requests, does not keep time.
 */
export interface Job {
  name: string;
  run: () => Promise<unknown>;
}

export const JOBS: Job[] = [
  { name: 'removing ended shares', run: () => sweepShares() },
  { name: 'reminding about cards', run: () => remindCardReviews() },
  { name: 'mailing due reminders', run: () => remindDue() },
  { name: 'removing ended sign-ins', run: () => sweepSessions() },
  { name: 'removing unconfirmed accounts', run: () => sweepUnverified() },
  { name: 'removing ended limit windows', run: () => getAccountsStore().maintenance.pruneWindows(Date.now()) },
  // Where the country file is kept in the bucket, once a day; nothing anywhere else.
  { name: 'refreshing the country file', run: () => refreshCountryFile() },
];

export const jobsAreExternal = (env: NodeJS.ProcessEnv = process.env): boolean => (env.SPINE_JOBS ?? 'internal') === 'external';

/** Runs every job once. A failing one is said and does not stop the rest; the result says how many failed, so a job runner can fail the run. */
export async function runJobs(log: (message: string, detail: Record<string, unknown>) => void, jobs: Job[] = JOBS): Promise<number> {
  let failed = 0;
  for (const job of jobs) {
    try {
      await job.run();
    } catch (err) {
      failed++;
      log(`${job.name} failed`, { err: err instanceof Error ? err.message : String(err) });
    }
  }
  return failed;
}

async function main(): Promise<void> {
  const { useAccountsStore } = await import('./store.js');
  useAccountsStore();
  const failed = await runJobs((message, detail) => console.error(`jobs: ${message} ${JSON.stringify(detail)}`));
  console.log(`jobs: ${JOBS.length - failed} of ${JOBS.length} done`);
  process.exit(failed === 0 ? 0 : 1);
}

// Only when executed directly, so importing this in a test or in the server does not run it.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('dist', 'jobs.js'))) {
  await main();
}
