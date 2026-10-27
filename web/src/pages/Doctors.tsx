import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type DoctorEntry, type DoctorSummary } from '../api';
import { useI18n } from '../i18n';

const DISMISSED = 'spine.doctors-not-the-same';
const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const readDismissed = (): string[] => { try { return JSON.parse(localStorage.getItem(DISMISSED) ?? '[]'); } catch { return []; } };
const writeDismissed = (keys: string[]) => { try { localStorage.setItem(DISMISSED, JSON.stringify(keys)); } catch { /* a convenience only */ } };

const describe = (d: DoctorSummary, tn: ReturnType<typeof useI18n>['tn']) =>
  `${d.name}${d.specialty ? ` (${d.specialty})` : ''}, ${tn(d.document_count, '{n} document', '{n} documents')}`;

/**
 * Entries that are probably one person written two ways. Never merged by itself: it cannot know, so the owner
 * says yes (merge into the fuller name) or "not the same", which is remembered in this browser only.
 */
function Duplicates({ onMerged }: { onMerged: () => void }) {
  const { t, tn } = useI18n();
  const [pairs, setPairs] = useState<Array<{ keep: DoctorSummary; other: DoctorSummary }>>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [error, setError] = useState('');
  useEffect(() => { api.doctors.duplicates().then(setPairs).catch(() => setPairs([])); }, []);

  const shown = pairs.filter(p => !dismissed.includes(pairKey(p.keep.id, p.other.id)));
  if (shown.length === 0) return null;

  const merge = async (p: (typeof pairs)[number]) => {
    setError('');
    try {
      await api.doctors.merge(p.keep.id, p.other.id);
      setPairs(prev => prev.filter(x => x !== p));
      onMerged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not merge'));
    }
  };
  const dismiss = (p: (typeof pairs)[number]) => {
    const next = [...dismissed, pairKey(p.keep.id, p.other.id)];
    setDismissed(next);
    writeDismissed(next);
  };

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4" aria-label={t('Possible duplicates')}>
      <h2 className="text-sm font-medium text-amber-900 mb-1">{t('Probably the same person')}</h2>
      <p className="text-xs text-amber-800 mb-3">{t('Written two ways on different documents. Merging keeps every document under the fuller name.')}</p>
      <ul className="space-y-3">
        {shown.map(p => (
          <li key={pairKey(p.keep.id, p.other.id)} className="text-sm text-gray-800">
            <p>{describe(p.other, tn)} <span className="text-gray-400">{t('and')}</span> {describe(p.keep, tn)}</p>
            <div className="flex gap-3 mt-1">
              <button type="button" onClick={() => merge(p)} className="text-brand-600 hover:underline">{t('Merge into {name}', { name: p.keep.name })}</button>
              <button type="button" onClick={() => dismiss(p)} className="text-gray-500 hover:underline">{t('Not the same')}</button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-red-600 mt-2" role="alert">{error}</p>}
    </div>
  );
}

export default function Doctors() {
  const { t, tn } = useI18n();
  const [doctors, setDoctors] = useState<DoctorEntry[] | null>(null);
  const [query, setQuery] = useState('');

  const reload = () => { api.doctors.list().then(setDoctors).catch(() => setDoctors([])); };
  useEffect(reload, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (doctors ?? []).filter(d => !q || [d.name, d.specialty, d.clinic].some(v => v?.toLowerCase().includes(q)));
  }, [doctors, query]);

  return (
    <div>
      <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mb-1">{t('Doctors')}</h1>
      <p className="text-sm text-gray-500 mb-4">{t('Everyone your documents name. The list grows as documents are read.')}</p>
      {doctors === null ? <p className="text-sm text-gray-400">{t('Loading…')}</p>
        : doctors.length === 0 ? (
          <div className="text-center py-16 text-gray-400"><p className="text-lg mb-2">{t('No doctors yet')}</p><p className="text-sm">{t('They are added as documents are read.')}</p></div>
        ) : (
          <>
            <Duplicates onMerged={reload} />
            <input
              type="search" aria-label={t('Filter doctors')} placeholder={t('Filter by name, specialty or clinic…')} value={query} onChange={e => setQuery(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {shown.length === 0 ? <p className="text-sm text-gray-400">{t('No doctor matches.')}</p> : (
              <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
                {shown.map(d => (
                  <li key={d.id}>
                    <Link to={`/doctors/${d.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900 truncate">{d.name}</span>
                        <span className="block text-xs text-gray-400 truncate">{[d.specialty, d.clinic, d.license_code].filter(Boolean).join(' · ') || t('No specialty yet')}</span>
                      </span>
                      <span className="text-right shrink-0 text-xs text-gray-500">
                        {tn(d.document_count, '{n} document', '{n} documents')}
                        {d.last_seen && <span className="block text-gray-400">{t('last {date}', { date: d.last_seen })}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
    </div>
  );
}
