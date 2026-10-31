import { useCallback, useEffect, useState } from 'react';
import { PROFILE_CHANGED, device, rememberProfile } from './core/client';
import { vaultState } from './crypto/vault-state';

export interface Person { id: string; name: string; shared?: { owner: string; role: 'guardian' | 'viewer' } }
export interface People { profiles: Person[]; current: string }

/**
 * The people (profiles) this account keeps records for and the one open now. Each has records and keys of their own (docs/key-hierarchy.md);
 * `null` until the vault is open. Looks again when another person's records are opened.
 */
export function useProfiles(open: boolean): { people: People | null; refresh: () => Promise<void> } {
  const [people, setPeople] = useState<People | null>(null);
  const refresh = useCallback(async () => {
    if (!open || !device.isOpen()) { setPeople(null); return; }
    try { setPeople(await device.profiles()); } catch { setPeople(null); }
  }, [open]);
  useEffect(() => {
    void refresh();
    window.addEventListener(PROFILE_CHANGED, refresh);
    return () => window.removeEventListener(PROFILE_CHANGED, refresh);
  }, [refresh]);
  return { people, refresh };
}

/** Opens another person's records, and remembers the choice on this device for the next sign-in. */
export async function openPerson(id: string, force = false): Promise<void> {
  await device.switchProfile(id, force);
  const account = vaultState.email();
  if (account) rememberProfile(account, id);
}
