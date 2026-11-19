import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type DoctorDetail, type DoctorEntry, type Document } from '../api';
import { sinceLastVisit } from '../since-last-visit';
import { ROLE_LABELS } from '../components/DoctorsPanel';
import { documentTitle } from '../titles';
import { useListTitles, useTerms } from '../useListTitles';
import { useI18n } from '../i18n';
import { useFormat } from '../format';
import { Combobox } from '../components/Combobox';

const input = 'w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500';
const label = 'block text-xs font-medium text-gray-500 mb-1';

export default function DoctorPage() {
  const { t } = useI18n();
  const format = useFormat();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [doctor, setDoctor] = useState<DoctorDetail | null>(null);
  const names = useTerms();
  const [missing, setMissing] = useState(false);
  const [others, setOthers] = useState<DoctorEntry[]>([]);
  const [archive, setArchive] = useState<Document[]>([]);
  // The titles in the reader's language for this doctor's documents and for the others' since the last visit, which the list below names too.
  const news = doctor ? sinceLastVisit(doctor.documents, archive) : null;
  const newsIds = news ? news.documents.slice(0, 10).map(d => d.id) : [];
  const { titleOf } = useListTitles([...(doctor?.documents ?? []).map(d => d.id), ...newsIds], false);
  const [form, setForm] = useState<{ name: string; specialty: string; clinic: string; license_code: string } | null>(null); // non-null while editing
  const [mergeFrom, setMergeFrom] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try { setDoctor(await api.doctors.get(id)); setMissing(false); } catch { setMissing(true); }
  }, [id]);

  useEffect(() => {
    setDoctor(null); setForm(null); setMessage(''); setError(''); setMergeFrom('');
    load();
    api.doctors.list().then(list => setOthers(list.filter(d => d.id !== id))).catch(() => {});
    api.documents.listAll().then(setArchive).catch(() => {});
  }, [id, load]);

  if (missing) return <p className="text-red-500 text-sm">{t('Doctor not found')}</p>;
  if (!doctor) return <p className="text-gray-400 text-sm">{t('Loading…')}</p>;

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await action(); setMessage(done); return true; }
    catch (err) { setError(err instanceof Error ? err.message : t('That did not work')); return false; }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!form) return;
    if (await run(() => api.doctors.update(doctor.id, { name: form.name, specialty: form.specialty.trim() || null, clinic: form.clinic.trim() || null, license_code: form.license_code.trim() || null }), t('Saved.'))) {
      setForm(null); await load();
    }
  };

  const merge = async () => {
    if (!mergeFrom) return;
    if (await run(() => api.doctors.merge(doctor.id, mergeFrom), t('Merged. Their documents are now listed here.'))) {
      setMergeFrom('');
      await load();
      api.doctors.list().then(list => setOthers(list.filter(d => d.id !== doctor.id))).catch(() => {});
    }
  };

  const remove = async () => {
    setBusy(true); setError('');
    try { await api.doctors.remove(doctor.id); navigate('/doctors', { replace: true }); }
    catch (err) { setError(err instanceof Error ? err.message : t('Could not delete')); setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Link to="/doctors" className="text-xs text-gray-400 hover:text-gray-600 block">← {t('All doctors')}</Link>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        {form === null ? (
          <>
            <h1 className="text-xl font-semibold text-gray-900 break-words">{doctor.name}</h1>
            <p className="text-sm text-gray-500">{[doctor.specialty ? names.specialty(doctor.specialty) : null, doctor.clinic].filter(Boolean).join(' · ') || t('No specialty or clinic yet')}</p>
            {doctor.license_code && <p className="text-xs text-gray-400">{t('Code {code}', { code: doctor.license_code })}</p>}
            <button className="text-sm text-brand-600 hover:underline mt-3" onClick={() => { setMessage(''); setForm({ name: doctor.name, specialty: doctor.specialty ?? '', clinic: doctor.clinic ?? '', license_code: doctor.license_code ?? '' }); }}>{t('Edit')}</button>
          </>
        ) : (
          <div className="space-y-3">
            <div><label htmlFor="n" className={label}>{t('Name')}</label><input id="n" className={input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div><label htmlFor="s" className={label}>{t('Specialty')}</label><input id="s" className={input} value={form.specialty} onChange={e => setForm({ ...form, specialty: e.target.value })} /></div>
            <div><label htmlFor="c" className={label}>{t('Clinic')}</label><input id="c" className={input} value={form.clinic} onChange={e => setForm({ ...form, clinic: e.target.value })} /></div>
            <div>
              <label htmlFor="l" className={label}>{t('Professional code')}</label>
              <input id="l" className={input} placeholder={t('Printed beside the signature, e.g. X12345')} value={form.license_code} onChange={e => setForm({ ...form, license_code: e.target.value })} />
              <p className="text-xs text-gray-400 mt-1">{t('Signature stamps are pictures, so this is rarely read from a scan. Entering it here lets a later document with the same code join this entry whatever the name looks like.')}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={save} disabled={busy} className="bg-brand-600 text-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">{t('Save')}</button>
              <button onClick={() => { setForm(null); setError(''); }} disabled={busy} className="px-4 py-1.5 rounded-full text-sm text-gray-600 border border-gray-300 hover:bg-gray-50">{t('Cancel')}</button>
            </div>
          </div>
        )}
        {message && <p className="text-sm text-green-700 mt-3" role="status">{message}</p>}
        {error && <p className="text-sm text-red-600 mt-3" role="alert">{error}</p>}
      </div>

      {(() => {
        if (!news || !news.since || news.documents.length === 0) return null;
        return (
          <div className="bg-white border border-gray-200 rounded-xl p-4" id="since-last-visit">
            <h2 className="font-medium text-gray-900 mb-1 text-sm">{t('From others since your last visit here')}</h2>
            <p className="text-xs text-gray-500 mb-3">{t('Documents dated after {date}, the last one that names this doctor.', { date: format.date(news.since) })}</p>
            <ul className="divide-y divide-gray-100">
              {news.documents.slice(0, 10).map(d => (
                <li key={d.id}>
                  <Link to={`/documents/${d.id}`} className="flex items-baseline justify-between gap-3 py-2 hover:bg-gray-50">
                    <span className="text-sm text-gray-900 truncate">{documentTitle({ ...d, title: titleOf(d) ?? d.title }, t)}</span>
                    <span className="text-xs text-gray-400 shrink-0">{d.doc_date ? format.date(d.doc_date) : ''}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {news.documents.length > 10 && <p className="mt-2 text-xs text-gray-500">{t('Showing the newest {shown} of {count}. Share these takes all {count}.', { shown: 10, count: news.documents.length })}</p>}
            <button type="button" onClick={() => navigate('/share', { state: { documentIds: news.documents.map(d => d.id) } })} className="mt-3 rounded-full border border-gray-300 px-4 py-1.5 text-sm text-gray-800 hover:bg-gray-50">{t('Share these')}</button>
          </div>
        );
      })()}

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <h2 className="font-medium text-gray-900 mb-3 text-sm">{t('Documents')}</h2>
        {doctor.documents.length === 0 ? <p className="text-xs text-gray-400">{t('No document names this doctor.')}</p> : (
          <ul className="divide-y divide-gray-100">
            {doctor.documents.map(d => (
              <li key={`${d.id}-${d.role}`}>
                <Link to={`/documents/${d.id}`} className="flex items-baseline justify-between gap-3 py-2 hover:bg-gray-50">
                  <span className="text-sm text-gray-900 truncate">{documentTitle({ ...d, title: titleOf(d) }, t)}</span>
                  <span className="text-xs text-gray-400 shrink-0">{t(ROLE_LABELS[d.role])} · {d.doc_date ? format.date(d.doc_date) : t('no date')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {others.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h2 className="font-medium text-gray-900 mb-1 text-sm">{t('Same person under another name?')}</h2>
          <p className="text-xs text-gray-500 mb-3">{t('Names are matched without titles, accents or word order, but not initials. Pick the other entry and its documents move here.')}</p>
          <div className="flex gap-2">
            <Combobox
              ariaLabel={t('Merge this entry into this doctor')} className={input} value={mergeFrom} onChange={setMergeFrom} placeholder={t('Choose a doctor…')}
              options={others.map(o => ({ value: o.id, label: o.name, hint: [o.specialty, o.license_code].filter(Boolean).join(' · ') || undefined }))}
            />
            <button onClick={merge} disabled={!mergeFrom || busy} className="shrink-0 px-4 py-1.5 rounded-full text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">{t('Merge')}</button>
          </div>
        </div>
      )}

      {doctor.documents.length === 0 && (
        <button onClick={remove} disabled={busy} className="text-sm text-red-600 hover:underline disabled:opacity-50">{t('Delete this doctor')}</button>
      )}
    </div>
  );
}
