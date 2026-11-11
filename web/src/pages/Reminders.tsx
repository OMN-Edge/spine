import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Reminder } from '../api';
import { useI18n } from '../i18n';
import { buttonClass, inputClass } from '../components/AuthCard';

const box = 'bg-white border border-gray-200 rounded-xl p-4';

/**
 * Follow-up reminders (FR-REM, SECURITY.md M-53). A document that says in so many words to come back is proposed here with the date worked out from it;
 * nothing is a reminder until its date and words are confirmed. On the day the person is mailed (and whoever looks after them), with no word of what it is
 * about: the words stay here.
 */
export default function Reminders() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Reminder[] | null>(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Record<string, { text: string; due_on: string }>>({});

  const load = useCallback(async () => {
    try { setRows((await api.reminders.list()).reminders); } catch { setRows([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setNotice('');
    try { await fn(); } catch (err) { setNotice(err instanceof Error ? err.message : t('Something went wrong. Try again.')); }
    await load();
  };
  if (!rows) return <p className="text-gray-400 text-sm">{t('Loading…')}</p>;

  const of = (status: Reminder['status']) => rows.filter(r => r.status === status);
  const editing = (r: Reminder) => draft[r.id] ?? { text: r.text, due_on: r.due_on };
  const from = (r: Reminder) => <Link to={`/documents/${r.document_id}`} className="text-brand-700 hover:underline">{r.document_title || t('Document')}</Link>;
  const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString();

  return (
    <div className="max-w-2xl">
      <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mb-1">{t('Reminders')}</h1>
      <p className="text-sm text-gray-500 mb-6">{t('Follow-ups that your documents ask for. Nothing is set until you confirm its date and words. You are mailed on the day, with no word of what it is about.')}</p>
      {notice && <p role="alert" className="text-sm text-red-700 mb-3">{notice}</p>}

      {rows.every(r => r.status === 'dismissed') && <p className="text-sm text-gray-500">{t('No reminders yet. When a document says to come back, it appears here for you to confirm.')}</p>}

      {of('proposed').length > 0 && (
        <section className="mb-8">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">{t('To confirm')}</h2>
          <ul className="space-y-3">
            {of('proposed').map(r => (
              <li key={r.id} className={box}>
                <p className="text-xs text-gray-500 mb-2">{from(r)}{r.document_date ? ` · ${day(r.document_date)}` : ''}</p>
                <input aria-label={t('Words of the reminder')} value={editing(r).text} maxLength={300} onChange={e => setDraft({ ...draft, [r.id]: { ...editing(r), text: e.target.value } })} className={inputClass} />
                <div className="flex flex-wrap items-center gap-3 mt-2">
                  <input aria-label={t('Date of the reminder')} type="date" value={editing(r).due_on} onChange={e => setDraft({ ...draft, [r.id]: { ...editing(r), due_on: e.target.value } })} className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                  <button onClick={() => void act(() => api.reminders.update(r.id, { status: 'confirmed', text: editing(r).text, due_on: editing(r).due_on }))} className={buttonClass}>{t('Set the reminder')}</button>
                  <button onClick={() => void act(() => api.reminders.update(r.id, { status: 'dismissed' }))} className="text-sm text-gray-600 underline">{t('Not needed')}</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {of('confirmed').length > 0 && (
        <section className="mb-8">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">{t('Coming up')}</h2>
          <ul className="space-y-3">
            {of('confirmed').map(r => (
              <li key={r.id} className={box}>
                <p className="text-sm text-gray-900">{r.text}</p>
                <p className="text-xs text-gray-500 mt-1">{t('Due {date}', { date: day(r.due_on) })} · {from(r)}</p>
                <div className="flex gap-3 mt-3 text-sm">
                  <button onClick={() => void act(() => api.reminders.update(r.id, { status: 'done' }))} className="text-brand-700 underline">{t('Mark done')}</button>
                  <button onClick={() => void act(() => api.reminders.remove(r.id))} className="text-gray-600 underline">{t('Delete')}</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {of('done').length > 0 && (
        <section>
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">{t('Done')}</h2>
          <ul className="space-y-2">
            {of('done').map(r => (
              <li key={r.id} className="text-sm text-gray-500 flex items-center justify-between gap-3">
                <span className="truncate">{r.text} · {from(r)}</span>
                <button onClick={() => void act(() => api.reminders.remove(r.id))} className="text-xs underline shrink-0">{t('Delete')}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
