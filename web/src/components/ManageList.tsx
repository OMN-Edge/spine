import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { Combobox } from './Combobox';

export interface ManagedItem {
  key: string;
  name: string;
  /** Said beside the name: how many documents or values it holds. */
  count: string;
  /** Where the name leads, if anywhere. */
  href?: string;
}

/**
 * A list of names the app extracted and the person reuses, with what can be done to each: rename (a name another
 * entry has makes the two one) and remove. The page decides what those do; this only asks and reports.
 */
export default function ManageList({ items, filterLabel, removeLabel, removeWarning, onRename, onRemove, empty }: {
  items: ManagedItem[];
  filterLabel: string;
  removeLabel: string;
  removeWarning: (item: ManagedItem) => string;
  /** Resolves to a sentence to show, or throws with the reason. */
  onRename: (item: ManagedItem, name: string) => Promise<string>;
  onRemove: (item: ManagedItem) => Promise<string>;
  empty: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ key: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => items.filter(i => i.name.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true); setError(''); setMessage('');
    try { setMessage(await action()); setEditing(null); setRemoving(null); }
    catch (err) { setError(err instanceof Error ? err.message : t('That did not work')); }
    finally { setBusy(false); }
  };

  if (items.length === 0) return <p className="text-sm text-gray-400">{empty}</p>;

  return (
    <div>
      <input
        type="search" value={query} onChange={e => setQuery(e.target.value)} aria-label={filterLabel} placeholder={filterLabel}
        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      {message && <p className="text-sm text-green-700 mb-3" role="status">{message}</p>}
      {error && <p className="text-sm text-red-600 mb-3" role="alert">{error}</p>}
      {shown.length === 0 ? <p className="text-sm text-gray-400">{t('Nothing matches.')}</p> : (
        <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
          {shown.map(item => (
            <li key={item.key} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  {item.href
                    ? <Link to={item.href} className="block text-sm font-medium text-gray-900 hover:text-brand-700 truncate">{item.name}</Link>
                    : <span className="block text-sm font-medium text-gray-900 truncate">{item.name}</span>}
                  <span className="block text-xs text-gray-400">{item.count}</span>
                </span>
                <span className="flex gap-3 text-xs shrink-0">
                  <button type="button" className="text-brand-600 hover:underline" onClick={() => { setError(''); setMessage(''); setRemoving(null); setEditing({ key: item.key, name: item.name }); }}>{t('Rename or merge')}</button>
                  <button type="button" className="text-red-600 hover:underline" onClick={() => { setError(''); setMessage(''); setEditing(null); setRemoving(item.key); }}>{removeLabel}</button>
                </span>
              </div>

              {editing?.key === item.key && (
                <form className="mt-3" onSubmit={e => { e.preventDefault(); void run(() => onRename(item, editing.name)); }}>
                  <div className="flex gap-2">
                    <Combobox
                      ariaLabel={t('New name')} value={editing.name} commitOnBlur
                      onChange={v => setEditing({ key: item.key, name: v })} newLabel={name => t('Rename to “{name}”', { name })}
                      options={items.filter(i => i.key !== item.key).map(i => ({ value: i.name, label: i.name, hint: String(i.count) }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <button type="submit" disabled={busy || editing.name.trim() === '' || editing.name === item.name} className="shrink-0 bg-brand-600 text-white rounded-full px-3 py-1.5 text-sm disabled:opacity-50">{t('Save')}</button>
                    <button type="button" onClick={() => setEditing(null)} className="shrink-0 px-2 text-sm text-gray-500">{t('Cancel')}</button>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{t('A name that is already in the list merges the two.')}</p>
                </form>
              )}

              {removing === item.key && (
                <div role="alertdialog" aria-label={removeLabel} className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-xs">
                  <p className="text-red-900">{removeWarning(item)}</p>
                  <div className="flex gap-2 mt-3">
                    <button type="button" disabled={busy} onClick={() => void run(() => onRemove(item))} className="bg-red-600 text-white rounded-lg px-3 py-1.5 hover:bg-red-700 disabled:opacity-50">{removeLabel}</button>
                    <button type="button" onClick={() => setRemoving(null)} className="px-3 py-1.5 rounded-lg text-gray-600 border border-gray-300 hover:bg-white">{t('Cancel')}</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
