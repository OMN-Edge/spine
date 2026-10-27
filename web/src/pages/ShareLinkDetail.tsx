import { LIFETIMES } from '../lifetimes';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Document, type ShareLinkChange, type ShareLinkDetail as Detail, type ShareLinkEvent } from '../api';
import { useChat } from '../components/ChatProvider';
import ShareRequestCard from '../components/ShareRequestCard';
import { announceChange, useOnDataChanged } from '../dataChanged';
import { LANGUAGES, useI18n } from '../i18n';
import { countryName } from '../i18n/useTranslation';
import { Combobox } from '../components/Combobox';
import { languageName } from '../i18n/useTranslation';
import { documentTitle } from '../titles';
import { describeScope, DocumentPicker } from './ShareLinks';

const box = 'bg-white border border-gray-200 rounded-xl p-5 mb-6';
const input = 'text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500';
const primary = 'bg-brand-600 text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50';

/**
 * One share link, to look into and to change after it was made: what it allows now, what it shares now, who has read it, who
 * asked to, and what has happened to it. Changing it takes effect at once for everyone holding the link; the link itself (its
 * address) never changes, and a revoked one stays revoked.
 */
export default function ShareLinkDetail() {
  const { id } = useParams<{ id: string }>();
  const { t, tn, lang } = useI18n();
  const chat = useChat();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ label: '', hours: 0, scans: false, approval: false, ask: false, language: '' });
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [all, setAll] = useState<Document[] | null>(null);
  const [showReads, setShowReads] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api.share.detail(id);
      setData(d);
      setForm({ label: d.link.label ?? '', hours: 0, scans: d.link.include_scans, approval: d.link.require_approval, ask: d.link.allow_chat, language: d.link.language ?? '' });
    } catch {
      setError(t('This link was not found.'));
    }
  }, [id, t]);
  useEffect(() => { void load(); }, [load]);
  useOnDataChanged(() => { void load(); });

  if (error) return <p className="text-sm text-red-600" role="alert">{error}</p>;
  if (!data || !id) return <p className="text-sm text-gray-400">{t('Loading…')}</p>;
  const { link, documents, access, requests, events } = data;
  const expired = new Date(link.expires_at) < new Date();
  const active = !link.revoked && !expired;
  const editable = !link.revoked;

  const save = async (change: ShareLinkChange) => {
    setBusy(true); setError(''); setSaved('');
    try {
      await api.share.change(id, change);
      setSaved(t('Saved'));
      setPicking(false);
      await load();
      announceChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = () => {
    const change: ShareLinkChange = {};
    if (form.label.trim() !== (link.label ?? '')) change.label = form.label.trim() || null;
    if (form.scans !== link.include_scans) change.include_scans = form.scans;
    if (form.approval !== link.require_approval) change.require_approval = form.approval;
    if (form.ask !== link.allow_chat) change.allow_chat = form.ask;
    if (form.language !== (link.language ?? '')) change.language = form.language || null;
    if (form.hours > 0) change.expires_hours = form.hours;
    if (Object.keys(change).length === 0) { setSaved(t('Nothing to change.')); return; }
    void save(change);
  };
  const startPicking = () => {
    setChosen(documents.map(d => d.id));
    setPicking(true);
    if (!all) void api.documents.listAll().then(setAll).catch(() => setAll([]));
  };
  const revoke = async () => {
    setBusy(true);
    try { await api.share.revoke(id); await load(); announceChange(); } finally { setBusy(false); }
  };

  const fieldName = (f: string) => ({ label: t('Name'), expires_at: t('Expires'), include_scans: t('Scans'), require_approval: t('Approval'), allow_chat: t('Recipient questions'), language: t('Language'), scope: t('What it shares') } as Record<string, string>)[f] ?? f;
  const valueText = (field: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return t('(empty)');
    if (typeof v === 'boolean') return v ? t('on') : t('off');
    if (field === 'expires_at') return String(v).slice(0, 10);
    if (field === 'language') return languageName(String(v));
    return String(v);
  };
  const eventLine = (e: ShareLinkEvent) => {
    if (e.kind === 'created') return t('Link created');
    if (e.kind === 'revoked') return t('Revoked');
    if (e.kind === 'approved') return t('A browser was approved');
    if (e.kind === 'denied') return t('A browser was denied or its approval withdrawn');
    try {
      const changes = (JSON.parse(e.detail ?? '{}') as { changes?: Array<{ field: string; from: unknown; to: unknown }> }).changes ?? [];
      return changes.map(c => `${fieldName(c.field)}: ${valueText(c.field, c.from)} → ${valueText(c.field, c.to)}`).join('; ');
    } catch { return t('Changed'); }
  };
  const when = (iso: string) => new Date(iso).toLocaleString();

  return (
    <div className="max-w-2xl mx-auto">
      <p className="mb-2 text-sm"><Link to="/share" className="text-brand-600">← {t('All share links')}</Link></p>
      <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900">{link.label ?? describeScope(link, t, tn)}</h1>
      <p className="text-sm text-gray-500 mb-6">
        {link.revoked ? t('Revoked') : expired ? t('Expired') : t('Active')} · {t('Expires {date}', { date: link.expires_at.slice(0, 10) })} · {t('Made {date}', { date: link.created_at.slice(0, 10) })}
      </p>

      {requests.some(r => r.status === 'pending') && (
        <div className="mb-6 space-y-2">
          <h2 className="font-medium text-gray-900">{t('Waiting for your approval')}</h2>
          {requests.filter(r => r.status === 'pending').map(r => <ShareRequestCard key={r.id} request={r} onDecided={() => void load()} />)}
        </div>
      )}

      <section className={box} aria-labelledby="settings">
        <h2 id="settings" className="font-medium text-gray-900 mb-4">{t('What it allows')}</h2>
        <div className="space-y-4">
          <div>
            <label htmlFor="d-label" className="block text-xs font-medium text-gray-500 mb-1">{t('Label (for your reference)')}</label>
            <input id="d-label" value={form.label} maxLength={80} disabled={!editable} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} className={`${input} w-full`} />
          </div>
          <div>
            <label htmlFor="d-days" className="block text-xs font-medium text-gray-500 mb-1">{t('Works until {date}', { date: link.expires_at.slice(0, 10) })}</label>
            <span className="text-sm text-gray-600">{t('Change to')}{' '}
              <select id="d-days" value={form.hours} disabled={!editable} onChange={e => setForm(f => ({ ...f, hours: parseInt(e.target.value) }))} className={`${input} w-40`}>
                <option value={0}>{t('Keep')}</option>
                {LIFETIMES.map(l => <option key={l.hours} value={l.hours}>{t('{time} from now', { time: t(l.label) })}</option>)}
              </select>
            </span>
          </div>
          <label className="flex items-start gap-2 text-sm text-gray-700"><input type="checkbox" checked={form.scans} disabled={!editable} onChange={e => setForm(f => ({ ...f, scans: e.target.checked }))} className="mt-0.5" /><span>{t('Include scans of the original pages')}</span></label>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.approval} disabled={!editable} onChange={e => setForm(f => ({ ...f, approval: e.target.checked }))} className="mt-0.5" />
            <span>{t('Ask me before anyone opens it')}
              {form.approval && !link.require_approval && <span className="block text-xs text-amber-700">{t('Everyone approved so far will have to ask again.')}</span>}
            </span>
          </label>
          {chat?.enabled && <label className="flex items-start gap-2 text-sm text-gray-700"><input type="checkbox" checked={form.ask} disabled={!editable} onChange={e => setForm(f => ({ ...f, ask: e.target.checked }))} className="mt-0.5" /><span>{t('Let the recipient ask questions')}</span></label>}
          <div>
            <label htmlFor="d-lang" className="block text-xs font-medium text-gray-500 mb-1">{t('Language the page opens in')}</label>
            <Combobox
              id="d-lang" value={form.language} disabled={!editable} onChange={v => setForm(f => ({ ...f, language: v }))} className={input}
              options={[{ value: '', label: t('Not set: the reader chooses') }, ...LANGUAGES.map(l => ({ value: l.code, label: l.name }))]}
            />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button type="button" disabled={busy || !editable} onClick={saveSettings} className={primary}>{t('Save changes')}</button>
          {!link.revoked && <button type="button" disabled={busy} onClick={() => void revoke()} className="text-sm text-red-500 hover:text-red-700">{t('Revoke')}</button>}
          {saved && <span className="text-sm text-green-700" role="status">{saved}</span>}
        </div>
        {link.revoked && <p className="mt-3 text-xs text-gray-500">{t('A revoked link cannot be changed.')}</p>}
      </section>

      <section className={box} aria-labelledby="shared">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 id="shared" className="font-medium text-gray-900">{t('What it shares')} <span className="text-xs font-normal text-gray-500">· {describeScope(link, t, tn)}</span></h2>
          {editable && !picking && <button type="button" onClick={startPicking} className="text-xs text-brand-600 hover:underline shrink-0">{t('Choose documents')}</button>}
        </div>
        {!data.scope_ok && <p className="text-sm text-red-600 mb-2">{t('This link cannot be read, so it shares nothing.')}</p>}
        {picking ? (
          all === null ? <p className="text-sm text-gray-400">{t('Loading…')}</p> : (
            <>
              <DocumentPicker docs={all} chosen={chosen} onChange={setChosen} />
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy || chosen.length === 0} onClick={() => void save({ scope: 'document_ids', scope_value: chosen })} className={primary}>{tn(chosen.length, 'Share these {n} document', 'Share these {n} documents')}</button>
                <button type="button" onClick={() => setPicking(false)} className="text-sm text-gray-600">{t('Cancel')}</button>
              </div>
            </>
          )
        ) : documents.length === 0 ? <p className="text-sm text-gray-400">{t('No documents in this share.')}</p> : (
          <ul className="divide-y divide-gray-100 text-sm">
            {documents.map(d => <li key={d.id} className="py-1.5 truncate"><Link to={`/documents/${d.id}`} className="text-gray-900 hover:text-brand-700">{documentTitle(d, t)}</Link>{d.doc_date && <span className="text-gray-400"> · {d.doc_date}</span>}</li>)}
          </ul>
        )}
      </section>

      <section className={box} aria-labelledby="activity">
        <h2 id="activity" className="font-medium text-gray-900 mb-3">{t('Who has read it')}</h2>
        {access.total === 0 ? <p className="text-sm text-gray-400">{t('Nobody has opened it yet.')}</p> : (
          <>
            <p className="text-sm text-gray-700 mb-3">
              {tn(link.view_count, 'Opened {n} time', 'Opened {n} times')} · {t('first {date}', { date: when(access.first_at!) })} · {t('last {date}', { date: when(access.last_at!) })}
            </p>
            <table className="w-full text-xs mb-3">
              <thead><tr className="text-left text-gray-500"><th className="font-medium py-1">{t('Country')}</th><th className="font-medium py-1">{t('Reads')}</th><th className="font-medium py-1">{t('Last')}</th></tr></thead>
              <tbody>{access.addresses.map(a => <tr key={a.country ?? 'none'} className="border-t border-gray-100"><td className="py-1">{countryName(a.country, lang) ?? t('unknown')}</td><td>{a.count}</td><td>{when(a.last_at)}</td></tr>)}</tbody>
            </table>
            <button type="button" onClick={() => setShowReads(s => !s)} className="text-xs text-brand-600 hover:underline">{showReads ? t('Hide the latest reads') : t('Show the latest reads')}</button>
            {showReads && <ul className="mt-2 space-y-0.5 text-xs text-gray-600">{access.recent.map((r, i) => <li key={i}>{when(r.accessed_at)} · {countryName(r.country, lang) ?? t('unknown')} · {r.document_id ? t('opened {title}', { title: documents.find(d => d.id === r.document_id)?.title || t('a document') }) : t('read the list')}</li>)}</ul>}
            <p className="mt-3 text-xs text-gray-500">{t('The country is worked out from the visitor’s connection, and the address itself is not kept. It does not prove who it was.')}</p>
          </>
        )}
      </section>

      {requests.length > 0 && (
        <section className={box} aria-labelledby="asked">
          <h2 id="asked" className="font-medium text-gray-900 mb-3">{t('Who asked to open it')}</h2>
          <div className="space-y-2">{requests.filter(r => r.status !== 'pending').map(r => <ShareRequestCard key={r.id} request={r} onDecided={() => void load()} />)}</div>
        </section>
      )}

      <section className={box} aria-labelledby="history">
        <h2 id="history" className="font-medium text-gray-900 mb-3">{t('History')}</h2>
        <ol className="space-y-1.5 text-sm">
          {events.map((e, i) => <li key={i} className="flex gap-3"><span className="shrink-0 text-xs text-gray-400 w-36">{when(e.at)}</span><span className="text-gray-700 break-words min-w-0">{eventLine(e)}</span></li>)}
          {events.length === 0 && <li className="text-gray-400">{t('Nothing recorded yet.')}</li>}
        </ol>
        {active && <p className="mt-3 text-xs text-gray-500">{t('Changes apply at once to everyone who holds the link.')}</p>}
      </section>
    </div>
  );
}
