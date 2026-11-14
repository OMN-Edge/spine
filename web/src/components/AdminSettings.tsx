import { useEffect, useState } from 'react';
import { api, type OperatorSetting } from '../api';
import { useI18n } from '../i18n';

/**
 * The settings the operator changes on the admin page: the dashboard's targets, the AI budget and alert, the reminder interval (the server's
 * `operator-settings.ts` says which there are and checks each value). The marketing role sees them and cannot change them. A setting left empty, or
 * set back, uses the server's variable or its default again. The names and the help are the server's, in English, as the guardrails are.
 */
export default function AdminSettings({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<OperatorSetting[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ key: string; text: string; error: boolean } | null>(null);

  useEffect(() => { api.admin.settings().then(r => { setRows(r.settings); setCanEdit(r.can_edit); }).catch(() => setRows(null)); }, []);
  if (!rows) return null;

  const save = async (key: string, value: number | null) => {
    setMessage(null);
    try {
      const r = await api.admin.setSetting(key, value);
      setRows(r.settings);
      setDrafts(d => { const { [key]: _gone, ...rest } = d; return rest; });
      setMessage({ key, text: t('Saved.'), error: false });
      onChanged();
    } catch (err) {
      setMessage({ key, text: err instanceof Error ? err.message : t('Could not save'), error: true });
    }
  };
  const SOURCE = { admin: t('set here'), environment: t('from the environment'), default: t('default') } as const;
  const suffix = { count: '', percent: '%', euros: '€', days: t('days') } as const;

  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Settings')}</h2>
      <p className="mt-1 text-sm text-ink/60">{canEdit ? t('Targets, the AI budget and the reminders. A change applies within half a minute.') : t('Only an administrator can change these.')}</p>
      <ul className="mt-5 divide-y divide-ink/10 rounded-2xl border border-ink/10 bg-surface">
        {rows.map(s => {
          const draft = drafts[s.key];
          const shown = draft ?? (s.value === null ? '' : String(s.value));
          const parsed = shown.trim() === '' ? null : Number(shown);
          const changed = draft !== undefined && parsed !== s.value;
          return (
            <li key={s.key} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <p className="font-medium">{s.label} <span className="ml-1 rounded-full bg-ink/[0.06] px-2 py-0.5 text-xs font-normal text-ink/60">{SOURCE[s.source]}</span></p>
                <p className="text-sm text-ink/60">{s.help}</p>
                {message?.key === s.key && <p role="status" className={`mt-1 text-sm ${message.error ? 'text-red-700' : 'text-green-700'}`}>{message.text}</p>}
              </div>
              <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); if (changed) void save(s.key, parsed); }}>
                <label className="sr-only" htmlFor={`setting-${s.key}`}>{s.label}</label>
                <span className="inline-flex items-center overflow-hidden rounded-full border border-ink/20 bg-surface focus-within:border-accent">
                  <input id={`setting-${s.key}`} type="number" inputMode="decimal" min={s.min} max={s.max} step={s.unit === 'euros' ? '0.01' : '1'} disabled={!canEdit}
                    value={shown} placeholder={t('off')} onChange={e => setDrafts(d => ({ ...d, [s.key]: e.target.value }))}
                    className="w-24 bg-surface px-3 py-1.5 text-right outline-none disabled:opacity-60" />
                  <span className="w-12 pr-3 text-right text-sm text-ink/55">{suffix[s.unit]}</span>
                </span>
                {canEdit && <button type="submit" disabled={!changed} className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90 disabled:opacity-40">{t('Save')}</button>}
                {canEdit && s.source === 'admin' && <button type="button" onClick={() => void save(s.key, null)} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-ink/5">{t('Reset')}</button>}
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
