import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { device, UnsavedChangesError } from '../core/client';
import { openPerson, useProfiles } from '../profiles';
import { planRefusal } from '../billing';
import { buttonClass, inputClass, Notice } from '../components/AuthCard';
import { useI18n } from '../i18n';

/**
 * The people whose records this account keeps (FR-PRF-01): a child, a parent, oneself. Each has records, search, shares and an emergency
 * card of their own, and a key of their own that only this account's keys open. One is open at a time; opening another saves the first.
 */
export default function Profiles() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { people, refresh } = useProfiles(true);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async (id: string, force = false) => {
    setError(''); setBusy(true);
    try {
      await openPerson(id, force);
      setUnsaved(null);
      navigate('/');
    } catch (err) {
      if (err instanceof UnsavedChangesError) setUnsaved(id);
      else setError(t('Could not open these records'));
    } finally { setBusy(false); }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError(''); setBusy(true);
    try {
      await device.createProfile(name);
      setName('');
      await refresh();
    } catch (err) {
      const plan = planRefusal(err);
      setError(plan ? t(plan) : t('Could not add this person'));
    } finally { setBusy(false); }
  };

  if (!people) return <p className="text-gray-500">{t('Loading…')}</p>;

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mb-1">{t('People')}</h1>
      <p className="text-sm text-gray-500 mb-6">{t('Keep the records of someone you look after, such as a child or a parent, apart from your own. Each person has records, search, share links and an emergency card of their own, and a key of their own.')}</p>

      <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {people.profiles.map(p => (
          <li key={p.id} className="p-4 flex items-center justify-between gap-3">
            <span className="text-gray-900">{p.name}{p.id === people.current && <span className="ml-2 text-xs text-green-700">{t('Open now')}</span>}</span>
            {p.id !== people.current && <button disabled={busy} onClick={() => void open(p.id)} className="text-sm text-brand-600 hover:underline">{t('Open')}</button>}
          </li>
        ))}
      </ul>
      {unsaved && (
        <Notice kind="error">
          {t('Some of the latest changes are not saved yet. If you open someone else’s records now, they will be lost.')}{' '}
          <button className="underline" onClick={() => void open(unsaved, true)}>{t('Open anyway')}</button>
        </Notice>
      )}

      <form onSubmit={e => void add(e)} className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <h2 className="font-medium text-gray-900 mb-1">{t('Add a person')}</h2>
        <p className="text-sm text-gray-500 mb-3">{t('Their records start empty. The name is kept with them, sealed like everything else.')}</p>
        <input className={inputClass} value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder={t('Name')} aria-label={t('Name')} />
        {error && <Notice kind="error">{error}</Notice>}
        <button type="submit" disabled={busy || !name.trim()} className={buttonClass}>{t('Add')}</button>
      </form>
      <p className="mt-6 text-sm"><Link to="/account" className="text-brand-600 hover:underline">{t('Account')}</Link></p>
    </div>
  );
}
