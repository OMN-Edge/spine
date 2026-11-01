/**
 * An invitation followed from a link (`/invite#<code>`) before the person has an account or has signed in: the code is kept for this tab
 * only, so it survives the sign-up and the sign-in and is offered on the page of people. It never goes to the server except to be used.
 */
const NAME = 'spine-invite';

export function keepInvite(code: string): void {
  try { sessionStorage.setItem(NAME, code); } catch { /* a private window: the code is typed */ }
}

export function pendingInvite(): string | null {
  try { return sessionStorage.getItem(NAME); } catch { return null; }
}

export function forgetInvite(): void {
  try { sessionStorage.removeItem(NAME); } catch { /* nothing kept */ }
}

/**
 * That joining worked, for the page that says so. Joining reloads the keys, which makes the page of people be drawn again, so a message held
 * in the page's own state is gone before it can be read; this is kept for this tab for a short while instead, and a later visit does not show it.
 */
const JOINED = 'spine-joined';
const JOINED_FOR_MS = 60_000;

export function rememberJoined(owner: string, now = Date.now()): void {
  try { sessionStorage.setItem(JOINED, JSON.stringify({ owner, at: now })); } catch { /* the page's own state shows it, if it survives */ }
}

export function recentlyJoined(now = Date.now()): string {
  try {
    const kept = JSON.parse(sessionStorage.getItem(JOINED) ?? 'null') as { owner?: unknown; at?: unknown } | null;
    return kept && typeof kept.owner === 'string' && typeof kept.at === 'number' && now - kept.at >= 0 && now - kept.at < JOINED_FOR_MS ? kept.owner : '';
  } catch { return ''; }
}

