import { useCallback, useEffect, useState } from 'react';
import { api, type CatalogView } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';
import { amountText, changesOf, formatMinor, providerName, stateOf, type CatalogProduct, type Draft, type Period } from './catalog-view';

/**
 * What is sold and for how much (the server's `billing/products.ts`): an administrator edits what is commercial (the name, whether a product is on sale, each amount), publishes it to the
 * payment provider, and checks where the provider differs. What a product includes is not here: it is the application's code. A changed amount is a new price, and the one before it
 * stays for the people who bought it. The buttons are single words; what each does is said in the line beside them.
 */
export default function AdminCatalog() {
  const { t } = useI18n();
  const [view, setView] = useState<CatalogView | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.admin.catalog().then(setView).catch(() => setError(t('Could not load the products.'))); }, [t]);
  useEffect(load, [load]);

  const run = async (work: () => Promise<void>) => {
    setError(''); setNotice(null); setBusy(true);
    try { await work(); load(); } catch (err) { setError(err instanceof Error ? err.message : t('Could not save.')); } finally { setBusy(false); }
  };
  const provider = providerName(view?.provider);
  const period = (p: string) => (p === 'month' ? t('Monthly') : p === 'year' ? t('Yearly') : t('Once'));

  if (!error && !view) return null;
  if (view && !view.enabled) return null;
  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Products')}</h2>
        {view?.environment === 'sandbox' && <span className="rounded-full border border-amber-600/40 px-2.5 py-0.5 text-xs text-amber-700">{t('Test mode')}</span>}
      </div>
      <div className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5">
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
        <p className="text-sm text-ink/80">{t('What is sold, and for how much. An amount is what a buyer pays, tax included.')}</p>
        <p className="mt-1 text-sm text-ink/60">{t('A changed amount is a new price. The old one stays for the people who bought it.')}</p>
        {view && !view.canPublish && <p className="mt-3 text-sm text-ink/70">{t('{provider} has its prices made in its own dashboard, so they are not changed here.', { provider })}</p>}
        {view?.canPublish && (
          <CatalogActions
            provider={provider} adoptable={view.adoptable ?? 0} busy={busy}
            onPublish={() => void run(async () => {
              const { reports } = await api.admin.publishCatalog();
              const failed = reports.filter(r => r.state === 'failed');
              setNotice(failed.length ? { kind: 'error', text: failed.map(r => `${r.product}: ${r.message ?? ''}`).join(' · ') } : { kind: 'ok', text: t('Published to {provider}.', { provider }) });
            })}
            onCheck={() => void run(async () => {
              const { differences } = await api.admin.checkCatalog();
              setNotice(differences.length
                ? { kind: 'error', text: differences.map(d => t('{product}, {period}: here {expected}, at {provider} {found}.', { product: d.product, period: period(d.period), provider, expected: formatMinor(d.expectedMinor, view.currency ?? 'EUR'), found: d.foundMinor === null ? t('not found') : formatMinor(d.foundMinor, view.currency ?? 'EUR') })).join(' · ') }
                : { kind: 'ok', text: t('Everything matches {provider}.', { provider }) });
            })}
            onImport={() => void run(async () => { const r = await api.admin.adoptCatalog(); setNotice({ kind: 'ok', text: t('Imported {count} prices.', { count: String(r.adopted) }) }); })}
          />
        )}
        {view?.canPublish && (
          <ul className="mt-5 grid gap-4">
            {(view.products ?? []).map(p => (
              <ProductCard
                key={p.id} product={p} currency={view.currency ?? 'EUR'} busy={busy} period={period}
                onRename={name => run(async () => { await api.admin.saveProduct(p.id, { name }); })}
                onSale={on => run(async () => { await api.admin.saveProduct(p.id, { on_sale: on }); })}
                onSave={changes => run(async () => { for (const c of changes) await api.admin.setPrice(p.id, c.period, c.amountMinor); })}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const pill = 'rounded-full border border-ink/20 px-4 py-1.5 text-sm text-ink/80 hover:bg-ink/5 disabled:opacity-50 disabled:hover:bg-transparent';
const primary = 'rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90 disabled:opacity-50';

/** The three things done with the whole catalog, each one word, and a line that says what they do. */
export function CatalogActions({ provider, adoptable, busy, onPublish, onCheck, onImport }: { provider: string; adoptable: number; busy: boolean; onPublish: () => void; onCheck: () => void; onImport: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={onPublish} className={primary} title={t('Send the new prices to {provider}', { provider })}>{t('Publish')}</button>
        <button type="button" disabled={busy} onClick={onCheck} className={pill} title={t('Compare the prices with what {provider} holds', { provider })}>{t('Check')}</button>
        {adoptable > 0 && <button type="button" disabled={busy} onClick={onImport} className={pill} title={t('Bring in the prices already in use at {provider}', { provider })}>{t('Import ({count})', { count: String(adoptable) })}</button>}
      </div>
      <p className="mt-2 text-xs text-ink/60">
        {t('Publish sends the new prices to {provider}. Check compares them with what {provider} holds.', { provider })}
        {adoptable > 0 && ` ${t('Import brings in the {count} prices already in use there.', { count: String(adoptable) })}`}
      </p>
    </div>
  );
}

/** One product: its name and whether it is on sale, and each price as a field with where it is at the provider. One Save for the prices that were changed. */
export function ProductCard({ product, currency, busy, period, onRename, onSale, onSave }: {
  product: CatalogProduct; currency: string; busy: boolean; period: (p: string) => string;
  onRename: (name: string) => Promise<void>; onSale: (on: boolean) => Promise<void>; onSave: (changes: Array<{ period: Period; amountMinor: number }>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(product.name);
  const [draft, setDraft] = useState<Draft>({});
  useEffect(() => setName(product.name), [product.name]);
  const outcome = changesOf(product, draft);
  const invalid = 'error' in outcome ? outcome.error : null;
  const changes = 'changes' in outcome ? outcome.changes : [];
  const symbol = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find(p => p.type === 'currency')?.value ?? currency;
  return (
    <li className="rounded-xl border border-ink/10 bg-paper/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {renaming ? (
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label={t('Name')} value={name} onChange={e => setName(e.target.value)} maxLength={120} className="min-w-0 rounded-full border border-ink/20 bg-paper px-3 py-1 text-sm" />
              <button type="button" disabled={busy || !name.trim() || name.trim() === product.name} onClick={() => void onRename(name.trim()).then(() => setRenaming(false))} className={primary}>{t('Save')}</button>
              <button type="button" onClick={() => { setName(product.name); setRenaming(false); }} className={pill}>{t('Cancel')}</button>
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <h3 className="font-medium text-ink">{product.name}</h3>
              <button type="button" onClick={() => setRenaming(true)} className="text-xs text-ink/60 underline underline-offset-2 hover:text-ink">{t('Rename')}</button>
            </div>
          )}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm text-ink/80">
          <input type="checkbox" checked={product.on_sale} disabled={busy} onChange={e => void onSale(e.target.checked)} />
          {t('Available')}
        </label>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11rem,16rem))]">
        {product.periods.map(p => {
          const current = product.prices.find(x => x.period === p);
          const state = stateOf(current);
          const typed = draft[p] ?? (current ? amountText(current.amount_minor) : '');
          return (
            <div key={p} className="rounded-lg border border-ink/10 p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="uppercase tracking-wide text-ink/60">{period(p)}</span>
                {state === 'sent' && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-accent">{t('Sent')}</span>}
                {state === 'waiting' && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700">{t('Not sent')}</span>}
                {state === 'none' && <span className="text-ink/50">{t('No price')}</span>}
              </div>
              <label className="mt-2 flex items-center gap-1.5">
                <span className="text-sm text-ink/60" aria-hidden="true">{symbol}</span>
                <input
                  aria-label={t('{period} amount', { period: period(p) })} inputMode="decimal" placeholder="0.00" value={typed}
                  aria-invalid={invalid === p} onChange={e => setDraft({ ...draft, [p]: e.target.value })}
                  className={`w-full min-w-0 rounded-full border bg-paper px-3 py-1 text-sm ${invalid === p ? 'border-red-500' : 'border-ink/20'}`}
                />
              </label>
              {invalid === p && <div className="mt-1 text-xs text-red-600">{t('Not an amount')}</div>}
              {current && current.earlier.length > 0 && <div className="mt-1.5 text-xs text-ink/55">{t('Earlier: {versions}', { versions: current.earlier.map(e => formatMinor(e.amount_minor, currency)).join(', ') })}</div>}
            </div>
          );
        })}
      </div>
      {changes.length > 0 && (
        <div className="mt-3 flex justify-end">
          <button type="button" disabled={busy || invalid !== null} onClick={() => void onSave(changes).then(() => setDraft({}))} className={primary}>{t('Save')}</button>
        </div>
      )}
    </li>
  );
}
