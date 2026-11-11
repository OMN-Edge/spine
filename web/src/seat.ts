/**
 * An invitation to a seat in a shared plan, followed from a link (`/family#<id>.<secret>`) before the person has signed in: kept for this tab
 * only, so it survives the sign-in, and offered on the account page. The secret goes nowhere but to be shown to its sender's plan and used.
 */
const NAME = 'spine-seat-invite';
const SHAPE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/** The link that carries an invitation (the secret is in the fragment, which a browser does not send). */
export const seatLink = (origin: string, id: string, secret: string): string => `${origin}/family#${id}.${secret}`;

export function keepSeatInvite(code: string): boolean {
  if (!SHAPE.test(code)) return false;
  try { sessionStorage.setItem(NAME, code); } catch { /* a private window: the link is followed again */ }
  return true;
}

export function pendingSeatInvite(): { id: string; secret: string } | null {
  try {
    const m = SHAPE.exec(sessionStorage.getItem(NAME) ?? '');
    return m ? { id: m[1]!, secret: m[2]! } : null;
  } catch { return null; }
}

export function forgetSeatInvite(): void {
  try { sessionStorage.removeItem(NAME); } catch { /* nothing kept */ }
}
