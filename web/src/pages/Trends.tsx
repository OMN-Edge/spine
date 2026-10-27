import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type TrendName, type TrendSeries } from '../api';
import { SeriesBody, TestList } from '../components/TrendViews';
import { useI18n } from '../i18n';
import { Combobox } from '../components/Combobox';
import { useScreen } from '../components/ChatProvider';

/** For a test written two ways by two labs: count this one as another, and remember it for later documents. */
function MergeTest({ canonical, others }: { canonical: string; others: TrendName[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (others.length === 0) return null;

  const merge = async () => {
    setBusy(true); setError('');
    try {
      await api.trends.merge(canonical, into);
      navigate(`/trends?name=${encodeURIComponent(into)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not merge'));
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mt-4">
      <h2 className="font-medium text-gray-900 mb-1 text-sm">{t('Same test under another name?')}</h2>
      <p className="text-xs text-gray-500 mb-3">
        {t('Labs name a test differently. Choose the one this should be counted with: these values move there, and a later document that uses this name is filed there too. To split them again, edit the values in their documents.')}
      </p>
      <div className="flex gap-2">
        <Combobox
          ariaLabel={t('Count this test as')} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white" value={into} onChange={setInto} placeholder={t('Choose a test…')}
          options={others.map(o => ({ value: o.canonical, label: o.name, hint: String(o.count) }))}
        />
        <button onClick={merge} disabled={!into || busy} className="shrink-0 px-4 py-1.5 rounded-full text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">{t('Merge')}</button>
      </div>
      {error && <p className="text-sm text-red-600 mt-2" role="alert">{error}</p>}
    </div>
  );
}

function Series({ canonical, others }: { canonical: string; others: TrendName[] }) {
  const { t } = useI18n();
  const [series, setSeries] = useState<TrendSeries | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSeries(null); setError('');
    api.trends.series(canonical).then(setSeries).catch(err => setError(err instanceof Error ? err.message : t('Could not load')));
  }, [canonical]);

  if (error) return <p className="text-sm text-red-600" role="alert">{error}</p>;
  if (!series) return <p className="text-sm text-gray-400">{t('Loading…')}</p>;
  return <SeriesBody series={series} documentHref={id => `/documents/${id}`} after={<MergeTest canonical={canonical} others={others} />} />;
}

export default function Trends() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const name = params.get('name');
  const [names, setNames] = useState<TrendName[] | null>(null);
  useScreen({ page: 'trends', test: name ?? undefined });

  // Again whenever the page changes: a merge leaves one name fewer.
  useEffect(() => { api.trends.names().then(setNames).catch(() => setNames([])); }, [name]);

  return (
    <div>
      {name ? (
        <>
          <Link to="/trends" className="text-xs text-gray-400 hover:text-gray-600 block mb-3">← {t('All tests')}</Link>
          <Series canonical={name} others={(names ?? []).filter(n => n.canonical !== name)} />
        </>
      ) : (
        <>
          <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mb-1">{t('Trends')}</h1>
          <p className="text-sm text-gray-500 mb-4">{t('Lab values and vitals from your documents, over time.')}</p>
          {names === null ? <p className="text-sm text-gray-400">{t('Loading…')}</p>
            : names.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <p className="text-lg mb-2">{t('No measurements yet')}</p>
                <p className="text-sm">{t('They appear when a lab result or a note with vitals is read.')}</p>
              </div>
            ) : <TestList names={names} hrefFor={canonical => `/trends?name=${encodeURIComponent(canonical)}`} />}
        </>
      )}
    </div>
  );
}
