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
