import { useEffect, useState } from 'react';
import { visitorCode } from 'spine-core/share-code';
import { sodium, toB64 } from '../crypto/sodium';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { device, UnsavedChangesError } from '../core/client';
import { openPerson, useProfiles } from '../profiles';
import { planRefusal } from '../billing';
import { buttonClass, inputClass, Notice } from '../components/AuthCard';
import { DateInput } from '../components/DateInput';
import ProfileAccess from '../components/ProfileAccess';
import { vaultState } from '../crypto/vault-state';
import { readInviteCode } from '../crypto/delegation';
import { pendingInvite, forgetInvite, rememberJoined, recentlyJoined, rememberTookOver, recentlyTookOver } from '../invite';
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
  // An invitation followed from a link, or a code typed below: who it is from is looked up before anything is used.
  const [pending, setPending] = useState(pendingInvite() ?? '');
  const [invitation, setInvitation] = useState<{ ownerEmail: string; role: 'guardian' | 'viewer' | 'self'; expiresAt: string } | 'invalid' | null>(null);
  const [typed, setTyped] = useState('');
  const [joined, setJoined] = useState(recentlyJoined());
  // Invitations this account accepted whose owner has not yet confirmed the code its key makes: the code is read to them (SECURITY.md S-39).
  const [waitingFor, setWaitingFor] = useState<Array<{ owner: string; code: string; grantId: string; role: 'guardian' | 'viewer' | 'self' }>>([]);
  const [tookOver, setTookOver] = useState(recentlyTookOver());
  const [editing, setEditing] = useState<{ id: string; name: string; born: string } | null>(null);

  // The page's own session needs the people's keys to make an invitation. Who was let in, paused or let back in by someone else changes
  // nothing in this account's vault, so the device would not notice: the people are read afresh whenever this page opens.
  useEffect(() => {
    void vaultState.session()?.loadProfiles().catch(() => undefined);
    if (device.isOpen()) void device.reloadKeys().catch(() => undefined);
    const session = vaultState.session();
    if (!session) return;
    void (async () => {
      const mine = await visitorCode(toB64(await sodium(), session.unlocked.publicKey));
      const held = (await session.delegations()).received.filter(g => g.state === 'paused' && !!g.owner_pin && !g.delegate_pinned);
      setWaitingFor(held.map(g => ({ owner: g.owner_email, code: mine, grantId: g.id, role: g.role })));
    })().catch(() => undefined);
  }, []);

  // While an owner has not yet confirmed the code, the page asks now and then; once they have, the records open as they do for an invitation accepted at once.
  useEffect(() => {
    if (waitingFor.length === 0) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const session = vaultState.session();
        if (!session) return;
        const received = (await session.delegations()).received;
        const started = waitingFor.filter(w => received.some(g => g.id === w.grantId && g.state === 'active'));
        if (started.length === 0) return;
        setWaitingFor(w => w.filter(x => !started.some(s => s.grantId === x.grantId)));
        for (const w of started) {
          rememberJoined(w.owner);
          await device.reloadKeys();
          await openPerson(`grant:${w.grantId}`, false, w.role === 'self');
          await refresh();
          setJoined(w.owner);
        }
      })().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingFor]);

  // Who the invitation is from and what it allows, before the person decides. Looking changes nothing.
  useEffect(() => {
    if (!pending) { setInvitation(null); return; }
    let live = true;
    void (async () => {
      const read = await readInviteCode(pending);
      const session = vaultState.session();
      if (!read.ok || !session) { if (live) setInvitation('invalid'); return; }
      try { const seen = await session.previewInvite(read.code); if (live) setInvitation(seen); } catch { if (live) setInvitation('invalid'); }
    })();
    return () => { live = false; };
  }, [pending]);

  const lookUp = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setPending(typed.trim());
    setTyped('');
  };

  const decline = () => { forgetInvite(); setPending(''); };

  const accept = async () => {
    setError(''); setBusy(true);
    try {
      const read = await readInviteCode(pending);
      const session = vaultState.session();
      if (!read.ok || !session) { setError(t('That code is not right. Check it and try again.')); return; }
      const accepted = await session.accept(read.code);
      forgetInvite();
      setPending('');
      if (accepted.waiting) {
        // The owner confirms the code this account's key makes before the access starts: nothing to open yet.
        setWaitingFor(w => [...w, { owner: accepted.ownerEmail, code: accepted.code, grantId: accepted.grantId, role: accepted.role }]);
        await refresh();
        return;
      }
      rememberJoined(accepted.ownerEmail); // before the keys are reloaded: the page is drawn again then, and starts from this
      await device.reloadKeys();
      // Someone joining their own records does not need the empty ones the account started with: those go as the records open.
      await openPerson(`grant:${accepted.grantId}`, false, accepted.role === 'self');
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
      rememberTookOver(); // before the records open: the page is drawn anew then, and starts from this
      await device.reloadKeys();
      await openPerson(entry.grant.profile_id);
      // A card the old owner's account published for this person becomes this account's, so its printed code is theirs to replace or turn off.
      await api.emergency.takeOver().catch(() => undefined);
      setTaking('');
      setTookOver(true);
      await refresh();
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
  const roleText = (role: 'guardian' | 'viewer' | 'self', owner: string) => role === 'self'
    ? t('{owner} invites you into your own records, which they have kept until now. You will be able to read and change them.', { owner })
    : role === 'guardian'
      ? t('{owner} invites you to look after the records of someone they care for. You will be able to read and change them.', { owner })
      : t('{owner} invites you to read the records of someone they care for. You will not be able to change them.', { owner });
  const current = people.profiles.find(p => p.id === people.current);

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mb-1">{t('People')}</h1>
      <p className="text-sm text-gray-500 mb-6">{t('Keep the records of someone you look after, such as a child or a parent, apart from your own. Each person has records, search, share links and an emergency card of their own, and a key of their own.')}</p>

      {pending && (
        <section id="invitations" className="bg-white border border-brand-200 rounded-xl p-5 mb-6">
          <h2 className="font-medium text-gray-900 mb-2">{t('Pending invitation')}</h2>
          {invitation === null && <p className="text-sm text-gray-500">{t('Loading…')}</p>}
          {invitation === 'invalid' && (
            <>
              <p className="text-sm text-gray-700">{t('This invitation cannot be used: it was already used or cancelled, or it has expired. Ask for a new one.')}</p>
              <button className="mt-3 text-sm text-gray-500 hover:underline" onClick={decline}>{t('Dismiss')}</button>
            </>
          )}
          {invitation && invitation !== 'invalid' && (
            <>
              <p className="text-sm text-gray-700">{roleText(invitation.role, invitation.ownerEmail)}</p>
              <p className="mt-1 text-xs text-gray-500">{t('It can be used until {when}.', { when: new Date(invitation.expiresAt).toLocaleDateString() })}</p>
              <div className="mt-3 flex items-center gap-4">
                <button disabled={busy} onClick={() => void accept()} className="rounded-full bg-brand-600 px-4 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-50">{t('Accept')}</button>
                <button disabled={busy} onClick={decline} className="text-sm text-gray-500 hover:underline">{t('Decline')}</button>
              </div>
            </>
          )}
        </section>
      )}
      {waitingFor.map((w, i) => (
        <section key={`${w.owner}-${i}`} className="mb-4 rounded-xl border border-gray-200 bg-white p-4" aria-live="polite">
          <p className="text-sm text-gray-800">{t('Read this code to {owner}. Your access starts when they confirm it is the same as the one on their screen.', { owner: w.owner })}</p>
          <p className="mt-2 font-mono text-lg tracking-widest text-gray-900" data-testid="grant-own-code">{w.code}</p>
        </section>
      ))}
      {joined && current?.shared && <Notice kind="ok">{current.name === joined ? t('You are now in the records {owner} shared with you. Switch between people from the menu at the top of the page.', { owner: joined }) : t('You are now in {name}’s records, shared by {owner}. Switch between people from the menu at the top of the page.', { name: current.name, owner: joined })}</Notice>}
      {tookOver && <Notice kind="ok">{t('These records are yours now. The person who kept them before is paused until you let them back in, and anyone else who looked after them has to be invited again by you.')}</Notice>}

      <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {people.profiles.map(p => (
          <li key={p.id} className="p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-gray-900">
                {p.name}{p.kind === 'child' && p.shared?.role !== 'self' && <span className="ml-2 text-xs text-gray-500">{ageLine(p.born)}</span>}
                {p.id === people.current && <span className="ml-2 text-xs text-green-700">{t('Open now')}</span>}
                {p.shared && (
                  <span className="block text-xs text-gray-500">
                    {p.shared.role === 'self'
                      ? t('Your own records, kept by {owner}', { owner: p.shared.owner })
                      : `${t('Shared by {owner}', { owner: p.shared.owner })} · ${p.shared.role === 'guardian' ? t('you can change the records') : t('you can only read the records')}`}
                  </span>
                )}
              </span>
              <span className="shrink-0 flex gap-3 text-sm">
                {p.id !== people.current && <button disabled={busy} onClick={() => void open(p.id)} className="text-brand-600 hover:underline">{t('Open')}</button>}
                {p.shared ? <button disabled={busy} onClick={() => void leave(p.id)} className="text-red-600 hover:underline">{t('Leave')}</button>
                  : <button className="text-gray-500 hover:underline" onClick={() => setEditing(editing?.id === p.id ? null : { id: p.id, name: p.name, born: p.born ?? '' })}>{t('Edit')}</button>}
              </span>
            </div>
            {p.shared?.role === 'self' && isAdult(p.born) && (
              <div className="mt-2 text-sm bg-brand-50 rounded-lg px-3 py-2 text-brand-900">
                <p className="font-medium">{t('You are 18: these records can be yours.')}</p>
                <p className="mt-1 text-xs">{t('Taking them over moves them into your own account, under a new key that only your account opens. {owner} is paused until you let them back in, and anyone else who looked after you has to be invited again. This cannot be undone.', { owner: p.shared.owner })}</p>
                {taking === p.id
                  ? <button disabled={busy} className="mt-2 rounded-full bg-brand-600 px-3 py-1 text-white" onClick={() => void takeOver(p.id)}>{t('Yes, take them over')}</button>
                  : <button className="mt-2 underline" onClick={() => setTaking(p.id)}>{t('Take over my records')}</button>}
              </div>
            )}
            {!p.shared && p.kind === 'child' && isAdult(p.born) && <p className="mt-2 text-xs text-brand-800 bg-brand-50 rounded-lg px-3 py-2">{t('{name} is now 18, and these records should be theirs. Let them in as themselves, below.', { name: p.name })}</p>}
            {editing?.id === p.id && (
              <form onSubmit={e => void saveEdit(e)} className="mt-2 space-y-2">
                <input className={inputClass} value={editing.name} maxLength={60} onChange={e => setEditing({ ...editing, name: e.target.value })} aria-label={t('Name')} />
                {p.kind === 'child' && <DateInput className={inputClass} value={editing.born} onChange={born => setEditing({ ...editing, born })} aria-label={t('Born (year-month-day)')} placeholder={t('Born (year-month-day)')} min="1900-01-01" max={new Date().toISOString().slice(0, 10)} />}
                <button type="submit" disabled={busy} className={buttonClass}>{t('Save')}</button>
                <button type="button" className="ml-3 text-sm text-gray-500 hover:underline" onClick={() => setEditing(null)}>{t('Cancel')}</button>
              </form>
            )}
            {!p.shared && <ProfileAccess person={p} />}
          </li>
        ))}
      </ul>
      {unsaved && (
        <Notice kind="error">
          {t('Some of the latest changes are not saved yet. If you open someone else’s records now, they will be lost.')}{' '}
          <button className="underline" onClick={() => void open(unsaved, true)}>{t('Open anyway')}</button>
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}

      <form onSubmit={e => void add(e)} className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <h2 className="font-medium text-gray-900 mb-1">{t('Add a person')}</h2>
        <p className="text-sm text-gray-500 mb-3">{t('Their records start empty. The name is kept with them, sealed like everything else.')}</p>
        <input className={inputClass} value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder={t('Name')} aria-label={t('Name')} />
        <label className="flex items-center gap-2 text-sm text-gray-700 mb-3"><input type="checkbox" checked={child} onChange={e => setChild(e.target.checked)} />{t('This is a child I look after')}</label>
        {child && <DateInput className={inputClass} value={born} onChange={setBorn} placeholder={t('Born (year-month-day)')} aria-label={t('Born (year-month-day)')} min="1900-01-01" max={new Date().toISOString().slice(0, 10)} />}
        <button type="submit" disabled={busy || !name.trim()} className={buttonClass}>{t('Add')}</button>
      </form>

      <form onSubmit={lookUp} className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <h2 className="font-medium text-gray-900 mb-1">{t('Join with a code')}</h2>
        <p className="text-sm text-gray-500 mb-3">{t('Someone who looks after a person can give you a code instead of a link. Type it here to see the invitation.')}</p>
        <input className={inputClass} value={typed} onChange={e => setTyped(e.target.value)} placeholder={t('The code')} aria-label={t('The code')} autoComplete="off" />
        <button type="submit" disabled={!typed.trim()} className={buttonClass}>{t('See the invitation')}</button>
      </form>
      <p className="mt-6 text-sm"><Link to="/account" className="text-brand-600 hover:underline">{t('Account')}</Link></p>
    </div>
  );
}
