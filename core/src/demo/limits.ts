import { settings, type Settings } from '../config.js';
import { getStore } from '../store/index.js';

/**
 * What a visitor may upload in the demo (SECURITY.md M-39): a few files, the first pages of each. The server gives them to the demo's
 * core with the rest of its settings (`GET /api/demo-relay/config`); a core that was not given them has no limits, as an account's has none.
 * They run in the visitor's browser, so they bind only a visitor who leaves the page as it is: what bounds the cost is the relay's count
 * of model calls for the demo, per address and for the whole instance.
 */
export interface DemoLimits { uploads: number; pages: number }

const positive = (value: string | undefined): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function demoLimits(env: Settings = settings()): DemoLimits | null {
  const uploads = positive(env.SPINE_DEMO_MAX_UPLOADS);
  const pages = positive(env.SPINE_DEMO_MAX_PAGES);
  return uploads && pages ? { uploads, pages } : null;
}

/** Whether the visitor has used up the demo's uploads: the sample records do not count. */
export async function demoUploadsUsed(userId: string, limits: DemoLimits): Promise<boolean> {
  return (await getStore().sourceFiles.listFor(userId)).filter(u => !u.sample).length >= limits.uploads;
}
