import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type TrendName } from '../api';
import ManageList from '../components/ManageList';
import { useI18n } from '../i18n';

type Tab = 'tags' | 'providers' | 'tests';

/**
 * The names the app extracted from the documents and reuses: tags, the clinics and laboratories on them, and the
 * tests behind the trends. Extraction names things as it reads them, so the same thing can arrive spelled several ways;
 * this is where the person tidies that. Doctors have their own page.
 */
export default function Library() {
  const { t, tn } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'providers' ? 'providers' : params.get('tab') === 'tests' ? 'tests' : 'tags';
  const [tags, setTags] = useState<Array<{ id: number; name: string; document_count: number }> | null>(null);
  const [providers, setProviders] = useState<Array<{ name: string; document_count: number }> | null>(null);
  const [tests, setTests] = useState<TrendName[] | null>(null);

  const load = useCallback(() => {
    if (tab === 'tags') api.tags.list().then(setTags).catch(() => setTags([]));
    if (tab === 'providers') api.providers.list().then(setProviders).catch(() => setProviders([]));
    if (tab === 'tests') api.trends.names().then(setTests).catch(() => setTests([]));
  }, [tab]);
  useEffect(load, [load]);

  const docs = (n: number) => tn(n, '{n} document', '{n} documents');
  const tabs: Array<[Tab, string]> = [['tags', t('Tags')], ['providers', t('Providers')], ['tests', t('Tests')]];

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">{t('Library')}</h1>
      <p className="text-sm text-gray-500 mb-4">
        {t('The names read from your documents and reused across them. Tidy duplicates here.')}{' '}
        <Link to="/doctors" className="text-blue-600 hover:underline">{t('Doctors')}</Link>
      </p>
      <nav className="flex gap-4 border-b border-gray-200 mb-5 text-sm" aria-label={t('Sections')}>
        {tabs.map(([key, name]) => (
          <button
            key={key} type="button" onClick={() => setParams(key === 'tags' ? {} : { tab: key })} aria-current={tab === key ? 'page' : undefined}
            className={`pb-2 -mb-px border-b-2 ${tab === key ? 'border-blue-600 text-blue-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
          >
            {name}
          </button>
        ))}
      </nav>

      {tab === 'tags' && (tags === null ? <p className="text-sm text-gray-400">{t('Loading…')}</p> : (
        <ManageList
          items={tags.map(x => ({ key: String(x.id), name: x.name, count: docs(x.document_count) }))}
          filterLabel={t('Filter tags…')} empty={t('No tags yet. They are added as documents are read.')} removeLabel={t('Remove tag')}
          removeWarning={item => t('Remove the tag "{name}" from every document? The documents stay. Share links that use this tag will share nothing.', { name: item.name })}
          onRename={async (item, name) => {
            const { result } = await api.tags.rename(Number(item.key), name);
            load();
            return result === 'merged' ? t('Merged into the tag that already had that name.') : t('Renamed.');
          }}
          onRemove={async item => { await api.tags.remove(Number(item.key)); load(); return t('Removed.'); }}
        />
      ))}

      {tab === 'providers' && (providers === null ? <p className="text-sm text-gray-400">{t('Loading…')}</p> : (
        <ManageList
          items={providers.map(x => ({ key: x.name, name: x.name, count: docs(x.document_count) }))}
          filterLabel={t('Filter providers…')} empty={t('No providers yet. They are read from documents.')} removeLabel={t('Clear provider')}
          removeWarning={item => t('Clear the provider "{name}" on every document that has it? The documents stay.', { name: item.name })}
          onRename={async (item, name) => { await api.providers.rename(item.key, name); load(); return t('Renamed.'); }}
          onRemove={async item => { await api.providers.rename(item.key, null); load(); return t('Cleared.'); }}
        />
      ))}

      {tab === 'tests' && (tests === null ? <p className="text-sm text-gray-400">{t('Loading…')}</p> : (
        <ManageList
          items={tests.map(x => ({ key: x.canonical, name: x.name, href: `/trends?name=${encodeURIComponent(x.canonical)}`, count: tn(x.count, '{n} value', '{n} values') }))}
          filterLabel={t('Filter tests…')} empty={t('No measurements yet')} removeLabel={t('Delete values')}
          removeWarning={item => t('Delete every value of "{name}"? The documents stay, but the values leave the trends and shares.', { name: item.name })}
          onRename={async (item, name) => {
            const { result } = await api.trends.rename(item.key, name);
            load();
            return result === 'merged' ? t('Merged into the test that already had that name.') : t('Renamed.');
          }}
          onRemove={async item => { await api.trends.remove(item.key); load(); return t('Deleted.'); }}
        />
      ))}
    </div>
  );
}
