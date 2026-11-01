import { useCallback, useEffect, useState } from 'react';
import type { Delegations } from '../crypto/vault-client';
import { showInviteCode } from '../crypto/delegation';
import { vaultState } from '../crypto/vault-state';
import { device } from '../core/client';
import { planRefusal } from '../billing';
import type { Person } from '../core/client';
import { mayHaveOwnAccount } from 'spine-core/family';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';

/**
 * Who else may open one person's records (SECURITY.md **M-49**): invite someone with a code, see who is let in, pause or end it. Ending it
 * replaces the person's key, which takes a moment and signs the account out of its other devices. Nothing here sees a record.
 */
export default function ProfileAccess({ person }: { person: Person }) {
  const { t } = useI18n();
  const { id: profileId, name } = person;
  // A child may have an account of their own from sixteen, with their guardian's consent: making the invitation is that consent.
  const ownAccount = person.kind !== 'child' || mayHaveOwnAccount(person.born);
  const [data, setData] = useState<Delegations | null>(null);
  const [role, setRole] = useState<'guardian' | 'viewer' | 'self'>('guardian');
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const session = vaultState.session();

  const load = useCallback(async () => {
    if (!session) return;
    try { setData(await session.delegations()); } catch { setError(t('Could not load who is let in')); }
  }, [session, t]);
  useEffect(() => { void load(); }, [load]);

  const run = async (work: () => Promise<unknown>, failed: string) => {
    setError(''); setBusy(true);
    try { await work(); await load(); } catch (err) { const plan = planRefusal(err); setError(plan ?? failed); } finally { setBusy(false); }
  };

  if (!session) return null;
  const mine = (data?.owned ?? []).filter(g => g.profile_id === profileId);
  const waiting = (data?.invites ?? []).filter(i => i.profile_id === profileId);
  const link = code ? `${window.location.origin}/invite#${code.code}` : '';

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 text-sm">
      <h3 className="font-medium text-gray-800">{t('Who else can open {name}’s records', { name })}</h3>
      {mine.length === 0 && waiting.length === 0 && <p className="text-gray-500 mt-1">{t('No one else.')}</p>}
      <ul className="mt-1 divide-y divide-gray-100">
        {mine.map(g => (
          <li key={g.id} className="py-1.5 flex items-center justify-between gap-2">
            <span className="text-gray-800 truncate">{g.delegate_email} · {g.role === 'self' ? t('has an account of their own') : g.role === 'guardian' ? t('can change them') : t('can only read them')}{g.state === 'paused' && ` · ${t('paused')}`}</span>
            <span className="shrink-0 flex gap-3">
              <button disabled={busy} className="text-brand-600 hover:underline" onClick={() => void run(() => session.setGrantState(g.id, g.state === 'paused' ? 'active' : 'paused'), t('Could not change this'))}>{g.state === 'paused' ? t('Resume') : t('Pause')}</button>
              <button disabled={busy} className="text-red-600 hover:underline" onClick={() => void run(async () => { await session.revoke(g.id); await device.reloadKeys(); }, t('Could not end this'))}>{t('End')}</button>
            </span>
          </li>
        ))}
        {waiting.map(i => (
          <li key={i.id} className="py-1.5 flex items-center justify-between gap-2">
            <span className="text-gray-500">{t('An invitation is waiting, until {when}', { when: new Date(i.expires_at).toLocaleDateString() })}</span>
            <button disabled={busy} className="text-red-600 hover:underline" onClick={() => void run(() => session.cancelInvite(i.id), t('Could not cancel this'))}>{t('Cancel')}</button>
          </li>
        ))}
      </ul>
      {error && <Notice kind="error">{error}</Notice>}
      {code ? (
        <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg p-3">
          <p className="text-gray-700">{t('Tell this code to the person, or send them the link. It works once, for a week, and Spine does not keep it.')}</p>
          <p className="mt-2 font-mono text-base tracking-wide text-gray-900 break-all">{showInviteCode(code.code)}</p>
          <p className="mt-1 text-xs text-gray-500 break-all">{link}</p>
          <button className="mt-2 text-brand-600 hover:underline" onClick={() => setCode(null)}>{t('Done')}</button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select aria-label={t('What they can do')} value={role} onChange={e => setRole(e.target.value as 'guardian' | 'viewer' | 'self')} className="border border-gray-300 rounded-lg px-2 py-1">
            <option value="guardian">{t('Can change the records')}</option>
            <option value="viewer">{t('Can only read the records')}</option>
            {ownAccount && <option value="self">{t('Is this person, with an account of their own')}</option>}
          </select>
          <button disabled={busy} className="text-brand-600 hover:underline" onClick={() => void run(async () => { await session.loadProfiles(); setCode(await session.invite(profileId, role)); }, t('Could not make a code'))}>{t('Let someone in')}</button>
        </div>
      )}
      {!ownAccount && <p className="mt-1 text-xs text-gray-500">{t('A child can have an account of their own from sixteen, with a guardian’s consent.')}</p>}
      <p className="mt-1 text-xs text-gray-500">{t('Ending access also gives the records a new key and signs this account out of its other devices. Anything the person already read cannot be taken back.')}</p>
    </div>
  );
}
