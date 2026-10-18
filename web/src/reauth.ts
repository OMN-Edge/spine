/**
 * The page asks for the password again before something a stolen session would use to take everything
 * (SECURITY.md S-33). One dialog, mounted once; any request that is answered `reauth_required` opens it and is
 * sent again if the password was right.
 */
type Asker = () => Promise<boolean>;

let asker: Asker | null = null;

export function registerReauthAsker(fn: Asker | null): void {
  asker = fn;
}

/** True once the password has been accepted; false if the person cancelled or no dialog is mounted. */
export function askForPassword(): Promise<boolean> {
  return asker ? asker() : Promise.resolve(false);
}
