import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { buttonClass, inputClass, Notice } from './AuthCard';
import { useI18n } from '../i18n';
import { prfSupported } from '../crypto/passkey-prf';

type Passkey = Awaited<ReturnType<typeof api.auth.passkeys.list>>[number];

/** Passkeys on the account page: add one for this device, rename, remove. Adding and removing ask for the password again. */
export default function Passkeys() {
  const { t } = useI18n();
  const [list, setList] = useState<Passkey[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.auth.passkeys.list().then(setList).catch(() => setList([])), []);
  useEffect(() => { void load(); }, [load]);
  if (!api.auth.passkeys.supported()) return null;

  const add = async () => {
    setBusy(true); setError('');
    try {
      await api.auth.passkeys.add(name.trim() || t('This device'));
      setName('');
      await load();
    } catch (err) {
      // Closing the browser's sheet is a choice, not a failure.
      if (!(err instanceof Error && err.name === 'NotAllowedError')) setError(err instanceof Error ? err.message : t('Could not add the passkey'));
    }
    setBusy(false);
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : t('Something went wrong. Try again.')); }
    await load();
  };

  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6" aria-labelledby="passkeys">
      <h2 id="passkeys" className="font-medium text-gray-900 mb-1">{t('Passkeys')}</h2>
      <p className="text-xs text-gray-500 mb-4">{t('Sign in with your fingerprint, face or device PIN instead of a password. A passkey is also your second factor, so it does not ask for a code.')}</p>
      {prfSupported() && <p className="text-xs text-gray-500 mb-4">{t('A passkey can also open your records without the master password, if your device supports it. The records stay encrypted: the passkey makes the key on this device and only a sealed copy is kept for it.')}</p>}
      {list && list.length > 0 && (
        <ul className="space-y-2 mb-4">
          {list.map(p => (
            <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0">
                <input
                  defaultValue={p.name} maxLength={60} aria-label={t('Passkey name')}
                  onBlur={e => { const v = e.target.value.trim(); if (v && v !== p.name) void act(() => api.auth.passkeys.rename(p.id, v)); }}
                  className="border border-transparent hover:border-gray-200 rounded px-1 py-0.5 text-gray-900 w-44 max-w-full"
                />
                <span className="block text-xs text-gray-400 px-1">
                  {t('added {date}', { date: p.created_at.slice(0, 10) })}{p.last_used_at ? ` · ${t('used {date}', { date: p.last_used_at.slice(0, 10) })}` : ''}{p.opens_vault ? ` · ${t('opens your records')}` : ''}{p.backed_up ? ` · ${t('synced between your devices')}` : ''}
                </span>
              </span>
              {prfSupported() && (
                <button type="button" onClick={() => void act(() => (p.opens_vault ? api.auth.passkeys.disableVaultUnlock(p.id) : api.auth.passkeys.enableVaultUnlock(p.id)))} className="text-xs text-brand-600 hover:underline shrink-0">
                  {p.opens_vault ? t('Stop opening my records with it') : t('Open my records with it')}
                </button>
              )}
              <button type="button" onClick={() => void act(() => api.auth.passkeys.remove(p.id))} className="text-xs text-gray-400 hover:text-red-600 hover:underline shrink-0">{t('Remove')}</button>
            </li>
          ))}
        </ul>
      )}
      <input value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder={t('Name for this passkey (optional)')} aria-label={t('Name for this passkey (optional)')} className={inputClass} />
      {error && <Notice kind="error">{error}</Notice>}
      <button type="button" onClick={add} disabled={busy} className={buttonClass}>{t('Add a passkey on this device')}</button>
    </section>
  );
}
