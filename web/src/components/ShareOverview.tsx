import type { ShareOverview as Overview } from 'spine-core/share-overview';
import { useI18n } from '../i18n';
import { useFormat } from '../format';

/**
 * The first thing a doctor sees on a shared page (T-02): whose records these are, until when the link works, why they were sent and, if the owner chose to, what the owner takes now and is
 * allergic to, in the owner's words with the day they wrote it. Never anything taken from the documents: a prescription from March does not say what is taken in November, and for a whole
 * history a list built from them is a long list of the past. The same view is what the owner previews before making the link.
 */
export default function ShareOverview({ overview, createdAt, expiresAt, count, years }: { overview: Overview | null; createdAt?: string | null; expiresAt?: string | null; count: number; years?: [string, string] | null }) {
  const { t, tn } = useI18n();
  const format = useFormat();
  const now = overview?.now ?? null;
  const lists: Array<[string, string[]]> = now ? [[t('Medicines'), now.medications], [t('Allergies'), now.allergies], [t('Conditions'), now.conditions]] : [];
  const facts = [
    createdAt ? t('Shared {date}', { date: format.date(createdAt) }) : null,
    expiresAt ? t('Open until {date}', { date: format.date(expiresAt) }) : null,
  ].filter((x): x is string => !!x);
  const range = years ? (years[0] === years[1] ? years[0] : `${years[0]}–${years[1]}`) : '';
  return (
    <section aria-label={t('About this link')} className="mb-6 rounded-xl border border-gray-200 bg-white p-4">
      {overview?.by && <h2 className="text-lg font-medium text-gray-900 break-words">{t('Records of {name}', { name: overview.by })}</h2>}
      {facts.length > 0 && <p className="text-sm text-gray-500 mt-0.5">{facts.join(' · ')}</p>}
      {overview?.note && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{t('Why this was shared')}</p>
          <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{overview.note}</p>
        </div>
      )}
      {lists.some(([, items]) => items.length > 0) && (
        <div className="mt-3 rounded-lg bg-gray-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{now?.written_on ? t('Written by the patient on {date}', { date: format.date(now.written_on) }) : t('Written by the patient')}</p>
          <dl className="mt-2 space-y-2">
            {lists.filter(([, items]) => items.length > 0).map(([name, items]) => (
              <div key={name}>
                <dt className="text-sm font-medium text-gray-900">{name}</dt>
                <dd className="text-sm text-gray-700"><ul className="list-disc pl-5">{items.map(item => <li key={item} className="break-words">{item}</li>)}</ul></dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <p className="mt-3 text-sm text-gray-600">{tn(count, '{n} document', '{n} documents')}{range ? `, ${range}` : ''}</p>
    </section>
  );
}
