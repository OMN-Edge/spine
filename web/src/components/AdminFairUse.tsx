import { useEffect, useState } from 'react';
import { api, type FairUseSection } from '../api';
import { useI18n } from '../i18n';

/**
 * The hidden fair-use ceilings (docs/billing.md): what no use of an archive reaches and an abuse of an account does. Drawn only for an administrator (the
 * server refuses everyone else, the marketing role too, and nothing here is ever shown to a user). Folded away by default: they are not changed often, and
 * a wrong value costs money or blocks a person. A value left to the file or the built-in one says so; "Reset" gives it back.
 */
export default function AdminFairUse() {
  const { t } = useI18n();
  const [sections, setSections] = useState<FairUseSection[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ path: string; text: string; error: boolean } | null>(null);
  useEffect(() => { api.admin.fairUse().then(r => setSections(r.sections)).catch(() => setSections(null)); }, []);
  if (!sections) return null;

  const GB = 1024 ** 3;
  const show = (unit: string, n: number) => (unit === 'bytes' ? String(Math.round((n / GB) * 100) / 100) : String(n));
  const read = (unit: string, text: string) => (unit === 'bytes' ? Number(text) * GB : Number(text));
  const SUFFIX: Record<string, string> = { count: '', bytes: 'GB', multiple: '×', fraction: '', euros: '€' };

  const save = async (path: string, value: number | null) => {
    setMessage(null);
    try {
      setSections((await api.admin.setFairUse(path, value)).sections);
      setDrafts(d => { const { [path]: _gone, ...rest } = d; return rest; });
      setMessage({ path, text: t('Saved.'), error: false });
    } catch (err) {
      setMessage({ path, text: err instanceof Error ? err.message : t('Could not save'), error: true });
    }
  };

  return (
    <section>
      <details className="group">
        <summary className="cursor-pointer list-none">
          <h2 className="inline font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Hidden ceilings')}</h2>
          <span className="ml-3 text-sm text-accent group-open:hidden">{t('Show')}</span>
        </summary>
        <p className="mt-1 text-sm text-ink/60">{t('What stops an abuse of one account and that no normal use reaches. Never shown to anyone else. A change applies within half a minute, and a value that is too low blocks real people.')}</p>
        <div className="mt-5 space-y-6">
          {sections.map(sec => (
            <div key={sec.title}>
              <h3 className="mb-2 font-medium">{sec.title}</h3>
              <ul className="divide-y divide-ink/10 rounded-2xl border border-ink/10 bg-surface">
                {sec.rows.map(r => {
                  const draft = drafts[r.path];
                  const shown = draft ?? show(r.unit, r.value);
                  const changed = draft !== undefined && shown.trim() !== '' && read(r.unit, shown) !== r.value;
                  return (
                    <li key={r.path} className="grid gap-2 px-5 py-3 md:grid-cols-[1fr_auto] md:items-center">
                      <div>
                        <p className="text-sm">{r.label} <span className="ml-1 rounded-full bg-ink/[0.06] px-2 py-0.5 text-xs text-ink/60">{r.source === 'admin' ? t('set here') : t('default')}</span></p>
                        {message?.path === r.path && <p role="status" className={`text-sm ${message.error ? 'text-red-700' : 'text-green-700'}`}>{message.text}</p>}
                      </div>
                      <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); if (changed) void save(r.path, read(r.unit, shown)); }}>
                        <label className="sr-only" htmlFor={`fair-${r.path}`}>{r.label}</label>
                        <span className="inline-flex items-center overflow-hidden rounded-full border border-ink/20 bg-surface focus-within:border-accent">
                          <input id={`fair-${r.path}`} type="number" inputMode="decimal" min={0} step="any" value={shown} onChange={e => setDrafts(d => ({ ...d, [r.path]: e.target.value }))} className="w-28 bg-surface px-3 py-1.5 text-right outline-none" />
                          <span className="w-10 pr-3 text-right text-sm text-ink/55">{SUFFIX[r.unit]}</span>
                        </span>
                        <button type="submit" disabled={!changed} className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90 disabled:opacity-40">{t('Save')}</button>
                        {r.source === 'admin' && <button type="button" onClick={() => void save(r.path, null)} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-ink/5">{t('Reset')}</button>}
                      </form>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
