import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { device, UnsavedChangesError } from '../core/client';
import { openPerson, useProfiles } from '../profiles';
import { planRefusal } from '../billing';
import { buttonClass, inputClass, Notice } from '../components/AuthCard';
import ProfileAccess from '../components/ProfileAccess';
import { vaultState } from '../crypto/vault-state';
import { readInviteCode } from '../crypto/delegation';
import { pendingInvite, forgetInvite, rememberJoined, recentlyJoined } from '../invite';
import { ageOn, isAdult, parseBorn } from 'spine-core/family';
import { useI18n } from '../i18n';

/**
 * The people whose records this account keeps (FR-PRF-01): a child, a parent, oneself. Each has records, search, shares and an emergency
 * card of their own, and a key of their own that only this account's keys open. One is open at a time; opening another saves the first.
 */
export default function Profiles() {
  const { t, tn } = useI18n();
  const ageLine = (born?: string) => { const age = ageOn(born); return age === null ? t('child') : tn(age, 'child, {n} year old', 'child, {n} years old'); };
  const navigate = useNavigate();
  const { people, refresh } = useProfiles(true);
  const [name, setName] = useState('');
  const [child, setChild] = useState(false);
  const [born, setBorn] = useState('');
  const [error, setError] = useState('');
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(pendingInvite() ?? '');
  const [joined, setJoined] = useState(recentlyJoined());
  const [openAccess, setOpenAccess] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; born: string } | null>(null);

  // The page's own session needs the people's keys to make an invitation.
  useEffect(() => { void vaultState.session()?.loadProfiles().catch(() => undefined); }, []);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const read = await readInviteCode(joining);
      if (!read.ok) { setError(t('That code is not right. Check it and try again.')); return; }
      const session = vaultState.session();
      if (!session) { setError(t('Open your records first.')); return; }
      const accepted = await session.accept(read.code);
      forgetInvite();
      rememberJoined(accepted.ownerEmail); // before the keys are reloaded: the page is drawn again then, and starts from this
      setJoining('');
      await device.reloadKeys();
      await refresh();
      setJoined(accepted.ownerEmail);
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 404 ? t('That code is not valid, or it has been used or has expired.') : t('Could not use this code'));
    } finally { setBusy(false); }
  };

  // At eighteen the records are the person's own: they take them into their own vault under a new key, and the guardians' access waits for their choice.
  const [taking, setTaking] = useState('');
  const takeOver = async (personId: string) => {
    setError(''); setBusy(true);
    try {
      const session = vaultState.session();
      if (!session || !people) { setError(t('Open your records first.')); return; }
      const grantId = personId.replace(/^grant:/, '');
      const entry = (await session.openReceived((await session.delegations()).received)).find(e => e.grant.id === grantId);
      if (!entry) { setError(t('Could not take over these records')); return; }
      // The records open on this device are the ones being moved: leave them first, on one of this account's own.
      const own = people.profiles.find(p => !p.shared);
      if (people.current === personId && own) await openPerson(own.id);
      await session.promote(entry);
      await device.reloadKeys();
      await openPerson(entry.grant.profile_id);
      // A card the old owner's account published for this person becomes this account's, so its printed code is theirs to replace or turn off.
      await api.emergency.takeOver().catch(() => undefined);
      setTaking('');
      navigate('/');
    } catch (err) {
      setError(err instanceof UnsavedChangesError ? t('Some of the latest changes are not saved yet.') : t('Could not take over these records'));
    } finally { setBusy(false); }
  };

  // Who a person is can be corrected: the name, and a child's birth date. The record is sealed again; the list is read again.
  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const person = people?.profiles.find(p => p.id === editing.id);
    if (!person || !editing.name.trim()) return;
    if (person.kind === 'child' && !parseBorn(editing.born)) { setError(t('A child’s records need a birth date, written year-month-day.')); return; }
    setError(''); setBusy(true);
    try {
      const session = vaultState.session();
      if (!session) { setError(t('Open your records first.')); return; }
      await session.loadProfiles();
      await session.updateProfile(editing.id, { name: editing.name.trim().slice(0, 60), ...(person.kind === 'child' ? { born: editing.born.trim() } : {}) });
      await device.reloadKeys();
      await refresh();
      setEditing(null);
    } catch {
      setError(t('Could not save this change'));
    } finally { setBusy(false); }
  };

  const leave = async (id: string) => {
    setError(''); setBusy(true);
    try { await vaultState.session()?.leave(id.replace(/^grant:/, '')); await device.reloadKeys(); await refresh(); } catch { setError(t('Could not leave')); } finally { setBusy(false); }
  };

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
    if (child && !parseBorn(born)) { setError(t('A child’s records need a birth date, written year-month-day.')); return; }
    setError(''); setBusy(true);
    try {
      await device.createProfile(name, child ? { born } : undefined);
      setName(''); setBorn(''); setChild(false);
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
          <li key={p.id} className="p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-gray-900">
                {p.name}{p.kind === 'child' && <span className="ml-2 text-xs text-gray-500">{ageLine(p.born)}</span>}
                {p.id === people.current && <span className="ml-2 text-xs text-green-700">{t('Open now')}</span>}
                {p.shared && <span className="block text-xs text-gray-500">{t('Shared by {owner}', { owner: p.shared.owner })} · {p.shared.role === 'guardian' ? t('you can change the records') : t('you can only read the records')}</span>}
              </span>
              <span className="shrink-0 flex gap-3 text-sm">
                {p.id !== people.current && <button disabled={busy} onClick={() => void open(p.id)} className="text-brand-600 hover:underline">{t('Open')}</button>}
                {p.shared ? <button disabled={busy} onClick={() => void leave(p.id)} className="text-red-600 hover:underline">{t('Leave')}</button>
                  : <>
                    <button className="text-gray-500 hover:underline" onClick={() => setEditing(editing?.id === p.id ? null : { id: p.id, name: p.name, born: p.born ?? '' })}>{t('Edit')}</button>
                    <button className="text-gray-500 hover:underline" onClick={() => setOpenAccess(openAccess === p.id ? '' : p.id)}>{t('Access')}</button>
                  </>}
              </span>
            </div>
            {p.shared?.role === 'self' && isAdult(p.born) && (
              <div className="mt-2 text-sm bg-brand-50 rounded-lg px-3 py-2 text-brand-900">
                <p className="font-medium">{t('You are 18: these records can be yours.')}</p>
                <p className="mt-1 text-xs">{t('Taking them over moves them into your own account, under a new key that only your account opens. The people who looked after you lose access until you let them back in, one by one. This cannot be undone.')}</p>
                {taking === p.id
                  ? <button disabled={busy} className="mt-2 rounded-full bg-brand-600 px-3 py-1 text-white" onClick={() => void takeOver(p.id)}>{t('Yes, take them over')}</button>
                  : <button className="mt-2 underline" onClick={() => setTaking(p.id)}>{t('Take over my records')}</button>}
              </div>
            )}
            {!p.shared && p.kind === 'child' && isAdult(p.born) && <p className="mt-2 text-xs text-brand-800 bg-brand-50 rounded-lg px-3 py-2">{t('{name} is now 18, and these records should be theirs. Let them in as themselves, under Access.', { name: p.name })}</p>}
            {editing?.id === p.id && (
              <form onSubmit={e => void saveEdit(e)} className="mt-2 space-y-2">
                <input className={inputClass} value={editing.name} maxLength={60} onChange={e => setEditing({ ...editing, name: e.target.value })} aria-label={t('Name')} />
                {p.kind === 'child' && <input className={inputClass} value={editing.born} onChange={e => setEditing({ ...editing, born: e.target.value })} aria-label={t('Born (year-month-day)')} placeholder={t('Born (year-month-day)')} inputMode="numeric" />}
                <button type="submit" disabled={busy} className={buttonClass}>{t('Save')}</button>
                <button type="button" className="ml-3 text-sm text-gray-500 hover:underline" onClick={() => setEditing(null)}>{t('Cancel')}</button>
              </form>
            )}
            {!p.shared && openAccess === p.id && <ProfileAccess person={p} />}
          </li>
        ))}
      </ul>
      {unsaved && (
        <Notice kind="error">
          {t('Some of the latest changes are not saved yet. If you open someone else’s records now, they will be lost.')}{' '}
          <button className="underline" onClick={() => void open(unsaved, true)}>{t('Open anyway')}</button>
        </Notice>
      )}

      <form onSubmit={e => void join(e)} className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <h2 className="font-medium text-gray-900 mb-1">{t('Join with a code')}</h2>
        <p className="text-sm text-gray-500 mb-3">{t('Someone who looks after a person can give you a code that lets you open that person’s records, here.')}</p>
        <input className={inputClass} value={joining} onChange={e => setJoining(e.target.value)} placeholder={t('The code')} aria-label={t('The code')} autoComplete="off" />
        {joined && <Notice kind="ok">{t('You can now open the records {owner} shared with you.', { owner: joined })}</Notice>}
        <button type="submit" disabled={busy || !joining.trim()} className={buttonClass}>{t('Join')}</button>
      </form>

      <form onSubmit={e => void add(e)} className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <h2 className="font-medium text-gray-900 mb-1">{t('Add a person')}</h2>
        <p className="text-sm text-gray-500 mb-3">{t('Their records start empty. The name is kept with them, sealed like everything else.')}</p>
        <input className={inputClass} value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder={t('Name')} aria-label={t('Name')} />
        <label className="flex items-center gap-2 text-sm text-gray-700 mt-2"><input type="checkbox" checked={child} onChange={e => setChild(e.target.checked)} />{t('This is a child I look after')}</label>
        {child && <input className={inputClass} value={born} onChange={e => setBorn(e.target.value)} placeholder={t('Born (year-month-day)')} aria-label={t('Born (year-month-day)')} inputMode="numeric" />}
        {error && <Notice kind="error">{error}</Notice>}
        <button type="submit" disabled={busy || !name.trim()} className={buttonClass}>{t('Add')}</button>
      </form>
      <p className="mt-6 text-sm"><Link to="/account" className="text-brand-600 hover:underline">{t('Account')}</Link></p>
    </div>
  );
}
