import { useCallback, useEffect, useState } from 'react';
import { PEOPLE_CHANGED, PROFILE_CHANGED, device, rememberProfile, type Person } from './core/client';
import { vaultState } from './crypto/vault-state';
import { api } from './api';

export type { Person };

/** What a person is called on screen: "Me" is the name an account gives its own first records, and is shown in the reader's language; any other name is the owner's own and is shown as written. */
export const personLabel = (name: string, t: (english: string) => string): string => (name === 'Me' ? t('Me') : name);
export interface People { profiles: Person[]; current: string }

/**
 * The people (profiles) this account keeps records for and the one open now. Each has records and keys of their own (docs/key-hierarchy.md);
 * `null` until the vault is open. Looks again when another person's records are opened, and when the list itself changes.
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
    window.addEventListener(PEOPLE_CHANGED, refresh);
    return () => { window.removeEventListener(PROFILE_CHANGED, refresh); window.removeEventListener(PEOPLE_CHANGED, refresh); };
  }, [refresh]);
  return { people, refresh };
}

/** Opens another person's records, and remembers the choice on this device for the next sign-in. */
export async function openPerson(id: string, force = false, dropEmpty = false): Promise<void> {
  await device.switchProfile(id, force, dropEmpty);
  const account = vaultState.email();
  if (account) rememberProfile(account, id);
}

/**
 * Changes who a profile says it is (its name and birth date, which the emergency card and a share link start from). The record is changed in the vault and the people are read
 * again; the card, if it is on, is sent again so the code already printed shows the change.
 */
export async function changeProfile(id: string, change: { name?: string; born?: string }): Promise<void> {
  const session = vaultState.session();
  if (!session) throw new Error('the records are not open');
  await session.loadProfiles();
  await session.updateProfile(id, change);
  await device.reloadKeys();
  const { current } = await device.profiles();
  if (id === current) await api.emergency.get().then(v => (v.published ? api.emergency.save(v.card) : undefined)).catch(() => undefined);
}
