import { useState } from 'react';
import { api, type DetailChange, type DocRef, type DoctorEntry, type LibraryEntry, type Proposal, type TestEntry } from '../api';
import { announceChange } from '../dataChanged';
import { useI18n } from '../i18n';
import { documentTitle } from '../titles';
import { useChat } from './ChatProvider';
import LinkWhyLine from './LinkWhy';
import DeviceImg from './DeviceImg';

/**
 * A change the chat prepared, waiting for the person. The words are written here, from the proposal's data, in the person's
 * language; the model supplies only the data (a note, a value, which documents). Nothing has happened until Confirm, which
 * sends the requests the proposal carries to the ordinary routes, and those check everything again.
 */
type State = 'waiting' | 'working' | 'done' | 'cancelled';

const button = 'rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50';
const primary = `${button} bg-blue-600 text-white hover:bg-blue-700`;
const quiet = `${button} border border-gray-200 text-gray-700 hover:bg-gray-50`;
const field = 'w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { t, tn } = useI18n();
  const currentId = useChat()?.currentId ?? null;
  const [state, setState] = useState<State>('waiting');
  const [error, setError] = useState('');
  const title = (d: DocRef) => documentTitle(d, t);

  /** Runs the proposal's requests one after another, stopping at the first that fails. */
  const confirmCalls = async (calls: Array<Parameters<typeof api.chat.run>[0]>) => {
    setState('working'); setError('');
    try {
      for (const call of calls) {
        await api.chat.run(call);
        // After each request, so the page behind shows pages moving as they move and not only when a slow last step (a reading) is over.
        announceChange();
      }
      setState('done');
    } catch (err) {
      setState('waiting');
      setError(err instanceof Error ? err.message : t('Could not make this change.'));
    }
  };

  const shell = (heading: string, body: React.ReactNode, footer?: React.ReactNode, doneText?: string) => (
    <section className="mt-3 rounded-xl border border-blue-100 bg-blue-50/40 p-3 text-xs text-gray-700" aria-label={heading}>
      <p className="mb-2 text-[0.8rem] font-medium text-gray-900">{heading}</p>
      {body}
      {state === 'done' && <p className="mt-2 font-medium text-green-700" role="status">{doneText ?? t('Done')}</p>}
      {state === 'cancelled' && <p className="mt-2 text-gray-500">{t('Cancelled')}</p>}
      {error && <p className="mt-2 text-red-600" role="alert">{error}</p>}
      {(state === 'waiting' || state === 'working') && footer}
    </section>
  );

  const confirmBar = (calls: Array<Parameters<typeof api.chat.run>[0]>) => (
    <div className="mt-3 flex gap-2">
      <button type="button" disabled={state === 'working'} onClick={() => void confirmCalls(calls)} className={primary}>{state === 'working' ? t('Working…') : t('Confirm')}</button>
      <button type="button" disabled={state === 'working'} onClick={() => setState('cancelled')} className={quiet}>{t('Cancel')}</button>
    </div>
  );

  const docList = (docs: DocRef[]) => (
    <ul className="space-y-0.5">{docs.map(d => <li key={d.id} className="truncate">· {d.title || d.doc_type || d.page_start == null ? title(d) : t('pages {pages}', { pages: d.page_start === d.page_end ? String(d.page_start) : `${d.page_start}–${d.page_end}` })}{d.doc_date ? ` (${d.doc_date})` : ''}</li>)}</ul>
  );

  const detailName = (what: 'title' | 'doc_date' | 'provider' | 'doc_type') =>
    what === 'title' ? t('Title') : what === 'doc_date' ? t('Date') : what === 'provider' ? t('Provider') : t('Type');
  const changeLine = (c: DetailChange, i: number) => {
    const empty = t('(empty)');
    switch (c.what) {
      case 'field_update': return <li key={i}><span className="text-gray-500">{c.label}:</span> <del className="text-gray-400">{c.from}</del> → <strong className="font-semibold">{c.to}</strong></li>;
      case 'field_add': return <li key={i}>{t('Add')} <span className="text-gray-500">{c.label}:</span> <strong className="font-semibold">{c.to}</strong></li>;
      case 'result_update': return <li key={i}><span className="text-gray-500">{c.name}:</span> <del className="text-gray-400">{c.from}</del> → <strong className="font-semibold">{c.to}</strong></li>;
      case 'result_add': return <li key={i}>{t('Add')} <span className="text-gray-500">{c.name}:</span> <strong className="font-semibold">{c.to}</strong></li>;
      case 'result_remove': return <li key={i}>{t('Remove')} <span className="text-gray-500">{c.name}:</span> <del className="text-gray-400">{c.from}</del></li>;
      case 'field_remove': return <li key={i}>{t('Remove')} <span className="text-gray-500">{c.label}:</span> <del className="text-gray-400">{c.from}</del></li>;
      default: return <li key={i}><span className="text-gray-500">{detailName(c.what)}:</span> <del className="text-gray-400">{c.from ?? empty}</del> → <strong className="font-semibold">{c.to ?? empty}</strong></li>;
    }
  };

  switch (proposal.kind) {
    case 'share_link':
      return <ShareCard proposal={proposal} state={state} setState={setState} shell={shell} />;

    case 'add_note':
      return shell(t('Add a note to “{title}”', { title: title(proposal.document) }),
        <blockquote className="whitespace-pre-wrap break-words rounded-lg border-l-2 border-blue-300 bg-white px-2.5 py-1.5 text-gray-800">{proposal.text}</blockquote>,
        confirmBar(proposal.calls));

    case 'edit_document':
      return shell(t('Change “{title}”', { title: title(proposal.document) }),
        <ul className="space-y-1 break-words">{proposal.changes.map(changeLine)}</ul>,
        confirmBar(proposal.calls));

    case 'tag_documents':
      return shell(tn(proposal.items.length, 'Change the tags of {n} document', 'Change the tags of {n} documents'),
        <ul className="space-y-0.5">
          {proposal.items.map(item => (
            <li key={item.document.id} className="break-words">
              {title(item.document)}:{' '}
              {item.add.map(tag => <span key={`+${tag}`} className="mr-1 rounded bg-green-100 px-1 text-green-800">+ {tag}</span>)}
              {item.remove.map(tag => <span key={`-${tag}`} className="mr-1 rounded bg-red-100 px-1 text-red-800">− {tag}</span>)}
            </li>
          ))}
        </ul>,
        confirmBar(proposal.calls));

    case 'mark_reviewed':
      return shell(tn(proposal.documents.length, 'Mark {n} document as reviewed', 'Mark {n} documents as reviewed'), docList(proposal.documents), confirmBar(proposal.calls));

    case 'link_documents': {
      const sentence = proposal.link_kind === 'requests' ? t('“{from}” asked for “{to}”', { from: title(proposal.from), to: title(proposal.to) })
        : proposal.link_kind === 'follow_up' ? t('“{to}” follows up “{from}”', { from: title(proposal.from), to: title(proposal.to) })
        : t('“{from}” and “{to}” are one episode of care', { from: title(proposal.from), to: title(proposal.to) });
      return shell(t('Connect two documents'), <p className="break-words">{sentence}</p>, confirmBar(proposal.calls));
    }

    case 'confirm_grouping':
      return shell(t('Confirm the grouping of “{name}”', { name: proposal.upload.file_name ?? proposal.upload.uploaded_at.slice(0, 10) }),
        <div className="space-y-1">
          <p>{t('Their fields and results are read now, once, and then they appear in the timeline and search:')}</p>{docList(proposal.documents)}
          <p className="text-gray-500">{t('Reading takes a while; I will not ask for anything else meanwhile.')}</p>
        </div>,
        confirmBar(proposal.calls),
        t('Started. The documents are read first, then they appear.'));

    case 'rotate_page':
      return shell(t('Turn page {n} of “{name}”', { n: proposal.page.number, name: proposal.upload.file_name ?? '' }),
        <div className="space-y-1">
          <p>{proposal.degrees === 90 ? t('A quarter turn clockwise.') : proposal.degrees === 270 ? t('A quarter turn anticlockwise.') : t('A half turn.')}</p>
          <p className="text-gray-500">{t('Nothing is read again. If the page was misread because it was sideways, read it again after.')}</p>
        </div>,
        confirmBar(proposal.calls));

    case 'hide_page':
      return shell(proposal.hidden ? t('Set aside page {n} of “{name}”', { n: proposal.page.number, name: proposal.upload.file_name ?? '' }) : t('Bring back page {n} of “{name}”', { n: proposal.page.number, name: proposal.upload.file_name ?? '' }),
        <div className="space-y-1">
          {proposal.document && <p>{proposal.hidden ? t('It leaves “{doc}”, its search and its next reading. It is kept, not deleted.', { doc: title(proposal.document) }) : t('It returns to “{doc}”.', { doc: title(proposal.document) })}</p>}
          <p className="text-gray-500">{t('The document goes back to review.')}</p>
        </div>,
        confirmBar(proposal.calls));

    case 'move_page':
      return shell(t('Move page {n} of “{name}”', { n: proposal.page.number, name: proposal.upload.file_name ?? '' }),
        <div className="space-y-1">
          <p>{proposal.to
            ? t('From “{from}” to “{to}”.', { from: title(proposal.from), to: title(proposal.to) })
            : t('From “{from}” into a document of its own.', { from: title(proposal.from) })}</p>
          <p className="text-gray-500">{t('The documents involved go back to review. Press Done on the upload’s grouping screen to read them again.')}</p>
        </div>,
        confirmBar(proposal.calls));

    case 'merge_documents':
      return shell(t('Combine two documents of “{name}”', { name: proposal.upload.file_name ?? '' }),
        <div className="space-y-1">
          <p>{t('“{from}” (pages {pages}) is added to the end of “{into}”, and the two become one.', { from: title(proposal.from), pages: proposal.page_numbers.join(', '), into: title(proposal.into) })}</p>
          <p className="text-gray-500">{t('The combined document is then read again once; what you edited is kept.')}</p>
        </div>,
        confirmBar(proposal.calls));

    case 'decide_links':
      return shell(tn(proposal.items.length, 'Confirm or dismiss {n} suggested connection', 'Confirm or dismiss {n} suggested connections'),
        <ul className="space-y-2">
          {proposal.items.map(i => (
            <li key={i.label} className="rounded-lg bg-white p-2">
              <p className="text-gray-900">
                {t('“{a}” and “{b}” may be connected', { a: title(i.from), b: title(i.to) })}
              </p>
              <p className={i.decision === 'confirm' ? 'font-medium text-green-700' : 'font-medium text-gray-600'}>{i.decision === 'confirm' ? t('Keep this connection') : t('Not related: do not suggest it again')}</p>
              {i.why && <p className="text-gray-500"><LinkWhyLine why={i.why} /></p>}
            </li>
          ))}
        </ul>,
        confirmBar(proposal.calls));

    case 'analyse_pages':
      return shell(t('Find which pages of “{name}” belong together', { name: proposal.upload.file_name ?? proposal.upload.uploaded_at.slice(0, 10) }),
        <div className="space-y-1">
          <p>{t('The text of its {n} pages is compared on this server, then the AI model is asked to check each group of pages that look alike. The text goes to the model provider, as it did when the pages were read.', { n: proposal.pages })}</p>
          <p className="text-gray-500">{t('Nothing is changed. It runs in the background, and I will message you when the suggestions are ready.')}</p>
        </div>,
        // The report is written in this conversation, not in a new one.
        confirmBar(proposal.calls.map(call => ({ ...call, body: { conversation_id: currentId } }))),
        t('Started. I will write here when the suggestions are ready.'));

    case 'regroup':
      return <RegroupCard proposal={proposal} state={state} setState={setState} shell={shell} />;

    case 'reread_pages':
      return shell(proposal.strategy === 'configured' ? t('Read “{title}” again', { title: title(proposal.document) }) : tn(proposal.page_numbers.length, 'Read page {pages} of “{title}” again with AI', 'Read pages {pages} of “{title}” again with AI', { pages: proposal.page_numbers.join(', '), title: title(proposal.document) }),
        <div className="space-y-1">
          <p>{proposal.sends_images ? t('The page image is sent to the AI model to be read. The document is then extracted again; your edits are kept.') : t('The text is read again on this server. The document is then extracted again; your edits are kept.')}</p>
          <p className="text-gray-500">{t('It runs in the background; the page updates when it is done.')}</p>
        </div>,
        confirmBar(proposal.calls),
        t('Started. The page updates when it is done.'));

    case 'merge_doctors':
      return <MergeDoctorsCard proposal={proposal} state={state} setState={setState} shell={shell} />;

    case 'merge_tests':
      return <MergeTestsCard proposal={proposal} state={state} setState={setState} shell={shell} />;

    case 'merge_library':
      return <MergeLibraryCard proposal={proposal} state={state} setState={setState} shell={shell} />;

    case 'update_share': {
      return shell(t('Change the link “{name}”', { name: proposal.link.label ?? t('A share link') }),
        <ul className="space-y-1 break-words">
          {proposal.label && <li><span className="text-gray-500">{t('Name')}:</span> <del className="text-gray-400">{proposal.label.from ?? t('(empty)')}</del> → <strong className="font-semibold">{proposal.label.to ?? t('(empty)')}</strong></li>}
          {proposal.expires && <li><span className="text-gray-500">{t('Works until')}:</span> <del className="text-gray-400">{proposal.link.expires_at.slice(0, 10)}</del> → <strong className="font-semibold">{new Date(Date.now() + proposal.expires.to_days * 86_400_000).toISOString().slice(0, 10)}</strong> <span className="text-gray-400">({tn(proposal.expires.to_days, '{n} day from now', '{n} days from now')})</span></li>}
          {proposal.added.map(d => <li key={`+${d.id}`}><span className="rounded bg-green-100 px-1 text-green-800">+</span> {title(d)}{d.doc_date ? ` (${d.doc_date})` : ''}</li>)}
          {proposal.removed.map(d => <li key={`-${d.id}`}><span className="rounded bg-red-100 px-1 text-red-800">−</span> {title(d)}{d.doc_date ? ` (${d.doc_date})` : ''}</li>)}
          {proposal.total_after !== null && <li className="text-gray-500">{tn(proposal.total_after, 'It will share {n} document.', 'It will share {n} documents.')}</li>}
          <li className="text-gray-500">{t('What it exposes (scans, approval, questions) is not changed here; use the link’s page for that.')}</li>
        </ul>,
        confirmBar(proposal.calls));
    }

    case 'revoke_share':
      return shell(t('Revoke the link “{name}”', { name: proposal.link.label ?? t('A share link') }),
        <p>{t('It stops working at once, for everyone who has it.')}</p>,
        confirmBar(proposal.calls));
  }
}

/**
 * A share link, editable before it is made: which documents, a name, how long it works, and what it exposes. The model proposed
 * the documents, the name and the length; the rest starts at the safe setting and is the person's to change here.
 */
function ShareCard({ proposal, state, setState, shell }: {
  proposal: Extract<Proposal, { kind: 'share_link' }>;
  state: 'waiting' | 'working' | 'done' | 'cancelled';
  setState: (s: 'waiting' | 'working' | 'done' | 'cancelled') => void;
  shell: (heading: string, body: React.ReactNode, footer?: React.ReactNode) => React.ReactElement;
}) {
  const { t, tn } = useI18n();
  const chat = useChat();
  const [docs, setDocs] = useState(proposal.documents);
  const [label, setLabel] = useState(proposal.label ?? '');
  const [days, setDays] = useState(proposal.expires_days);
  const [scans, setScans] = useState(proposal.include_scans);
  const [approval, setApproval] = useState(proposal.require_approval);
  const [ask, setAsk] = useState(proposal.allow_chat);
  const [error, setError] = useState('');
  const [made, setMade] = useState<{ url: string; expires: string } | null>(null);
  const [copied, setCopied] = useState('');

  const create = async () => {
    setState('working'); setError('');
    try {
      const result = await api.share.create({
        label: label.trim() || undefined, scope: 'document_ids', scope_value: docs.map(d => d.id), expires_days: days,
        include_scans: scans, require_approval: approval, allow_chat: ask, language: proposal.language,
      });
      setMade({ url: result.url, expires: result.expires_at.slice(0, 10) });
      setState('done');
      announceChange();
    } catch (err) {
      setState('waiting');
      setError(err instanceof Error ? err.message : t('Could not create the link'));
    }
  };
  const copy = async (what: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { /* the text is on screen to select */ }
  };

  const body = made ? (
    <div className="space-y-2">
      <code className="block break-all rounded-lg bg-white px-2.5 py-1.5 text-gray-800">{made.url}</code>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={quiet} onClick={() => void copy('link', made.url)}>{copied === 'link' ? t('Copied') : t('Copy')}</button>
        <button type="button" className={quiet} onClick={() => void copy('message', t('Here are the records I would like you to look at: {url} The link works until {date}.', { url: made.url, date: made.expires }))}>
          {copied === 'message' ? t('Copied') : t('Copy as a message')}
        </button>
      </div>
    </div>
  ) : (
    <div className="space-y-2.5">
      <ul className="space-y-1">
        {docs.map(d => (
          <li key={d.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{documentTitle(d, t)}{d.doc_date ? ` (${d.doc_date})` : ''}</span>
            {docs.length > 1 && state === 'waiting' && (
              <button type="button" onClick={() => setDocs(prev => prev.filter(x => x.id !== d.id))} aria-label={t('Remove from this link')} title={t('Remove from this link')} className="shrink-0 rounded px-1.5 text-gray-400 hover:bg-white hover:text-red-600">×</button>
            )}
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <input value={label} onChange={e => setLabel(e.target.value)} maxLength={80} aria-label={t('Label (for your reference)')} placeholder={t('Label (for your reference)')} className={field} />
        <input type="number" min={1} max={30} value={days} onChange={e => setDays(Math.min(30, Math.max(1, parseInt(e.target.value) || 1)))} aria-label={t('Expires in (days, max 30)')} title={t('Expires in (days, max 30)')} className={`${field} w-16`} />
      </div>
      <label className="flex items-start gap-2"><input type="checkbox" checked={approval} onChange={e => setApproval(e.target.checked)} className="mt-0.5" /><span>{t('Ask me before anyone opens it')}</span></label>
      {approval && !proposal.approval_mail && <p className="text-amber-700">{t('No email is set up on this server, so requests are not emailed. They wait on this page.')}</p>}
      <label className="flex items-start gap-2"><input type="checkbox" checked={scans} onChange={e => setScans(e.target.checked)} className="mt-0.5" /><span>{t('Include scans of the original pages')}</span></label>
      {scans && <p className="text-amber-700">{t("A scan shows everything on the page, including the patient's ID number and phone, which the extracted details leave out.")}</p>}
      {chat?.enabled && <label className="flex items-start gap-2"><input type="checkbox" checked={ask} onChange={e => setAsk(e.target.checked)} className="mt-0.5" /><span>{t('Let the recipient ask questions')}</span></label>}
    </div>
  );

  return shell(
    made ? t('Link created') : tn(docs.length, 'Share {n} document', 'Share {n} documents'),
    body,
    <div className="mt-3 flex gap-2">
      <button type="button" disabled={state === 'working' || docs.length === 0} onClick={() => void create()} className={primary}>{state === 'working' ? t('Creating…') : t('Create link')}</button>
      <button type="button" disabled={state === 'working'} onClick={() => setState('cancelled')} className={quiet}>{t('Cancel')}</button>
      {error && <span className="self-center text-red-600" role="alert">{error}</span>}
    </div>,
  );
}

type Shell = (heading: string, body: React.ReactNode, footer?: React.ReactNode) => React.ReactElement;
type CardState = 'waiting' | 'working' | 'done' | 'cancelled';

/**
 * Entries for one person written several ways. Each group shows its variants and the one final form they would all become,
 * which the person can edit; a variant can be left out (it stays as it is), and a whole group can be skipped. Confirm folds each
 * included variant into the kept entry, then writes the final form onto it.
 */
function MergeDoctorsCard({ proposal, state, setState, shell }: { proposal: Extract<Proposal, { kind: 'merge_doctors' }>; state: CardState; setState: (s: CardState) => void; shell: Shell }) {
  const { t, tn } = useI18n();
  const [groups, setGroups] = useState(() => proposal.groups.map(g => ({ ...g, on: true, skip: new Set<string>(), final: { ...g.final, specialty: g.final.specialty ?? '', clinic: g.final.clinic ?? '', license_code: g.final.license_code ?? '' } })));
  const [error, setError] = useState('');
  const edit = (i: number, key: 'name' | 'specialty' | 'clinic' | 'license_code', value: string) => setGroups(prev => prev.map((g, n) => n === i ? { ...g, final: { ...g.final, [key]: value } } : g));
  const variant = (d: DoctorEntry) => `${d.name}${d.specialty ? `, ${d.specialty}` : ''}${d.clinic ? `, ${d.clinic}` : ''} · ${d.license_code ?? t('no code')} · ${tn(d.document_count, '{n} document', '{n} documents')}`;

  const confirm = async () => {
    setState('working'); setError('');
    try {
      for (const g of groups) {
        if (!g.on) continue;
        const members = g.merge.filter(m => !g.skip.has(m.id));
        for (const m of members) await api.chat.run({ method: 'POST', path: `/api/doctors/${g.keep.id}/merge`, body: { from: m.id } });
        if (!g.final.name.trim()) throw new Error(t('A name is needed.'));
        await api.chat.run({ method: 'PATCH', path: `/api/doctors/${g.keep.id}`, body: { name: g.final.name.trim(), specialty: g.final.specialty.trim(), clinic: g.final.clinic.trim(), license_code: g.final.license_code.trim() } });
      }
      setState('done');
      announceChange();
    } catch (err) {
      setState('waiting');
      setError(err instanceof Error ? err.message : t('Could not make this change.'));
    }
  };

  return shell(
    tn(groups.length, 'Merge duplicate doctors ({n} group)', 'Merge duplicate doctors ({n} groups)'),
    <div className="space-y-3">
      {groups.map((g, i) => (
        <div key={g.keep.id} className={`rounded-lg border border-gray-200 bg-white p-2.5 ${g.on ? '' : 'opacity-50'}`}>
          <label className="mb-1.5 flex items-center gap-2 font-medium"><input type="checkbox" checked={g.on} disabled={state !== 'waiting'} onChange={e => setGroups(prev => prev.map((x, n) => n === i ? { ...x, on: e.target.checked } : x))} />{t('Merge this group')}</label>
          <ul className="mb-2 space-y-0.5 text-gray-600">
            <li className="break-words"><strong className="font-semibold">{t('Kept')}:</strong> {variant(g.keep)}</li>
            {g.merge.map(m => (
              <li key={m.id} className="flex gap-2 break-words">
                <input type="checkbox" checked={!g.skip.has(m.id)} disabled={state !== 'waiting' || !g.on} aria-label={t('Fold into the kept entry')}
                  onChange={e => setGroups(prev => prev.map((x, n) => n === i ? { ...x, skip: new Set(e.target.checked ? [...x.skip].filter(id => id !== m.id) : [...x.skip, m.id]) } : x))} />
                <span>{variant(m)}</span>
              </li>
            ))}
          </ul>
          <p className="mb-1 text-gray-500">{t('Final form, for all of them')}</p>
          <div className="grid grid-cols-2 gap-1.5">
            <input className={field} value={g.final.name} onChange={e => edit(i, 'name', e.target.value)} maxLength={120} aria-label={t('Name')} placeholder={t('Name')} disabled={!g.on} />
            <input className={field} value={g.final.license_code} onChange={e => edit(i, 'license_code', e.target.value)} maxLength={24} aria-label={t('Professional code')} placeholder={t('Professional code')} disabled={!g.on} />
            <input className={field} value={g.final.specialty} onChange={e => edit(i, 'specialty', e.target.value)} maxLength={80} aria-label={t('Specialty')} placeholder={t('Specialty')} disabled={!g.on} />
            <input className={field} value={g.final.clinic} onChange={e => edit(i, 'clinic', e.target.value)} maxLength={120} aria-label={t('Clinic')} placeholder={t('Clinic')} disabled={!g.on} />
          </div>
        </div>
      ))}
      {error && <p className="text-red-600" role="alert">{error}</p>}
    </div>,
    <div className="mt-3 flex gap-2">
      <button type="button" disabled={state === 'working' || !groups.some(g => g.on)} onClick={() => void confirm()} className={primary}>{state === 'working' ? t('Working…') : t('Confirm')}</button>
      <button type="button" disabled={state === 'working'} onClick={() => setState('cancelled')} className={quiet}>{t('Cancel')}</button>
    </div>,
  );
}

/**
 * Names for one test. The final name is editable; a warning is shown when the names carry different units, since a trend that
 * mixes g/dL and g/L is wrong even if both are "hemoglobin".
 */
function MergeTestsCard({ proposal, state, setState, shell }: { proposal: Extract<Proposal, { kind: 'merge_tests' }>; state: CardState; setState: (s: CardState) => void; shell: Shell }) {
  const { t, tn } = useI18n();
  const [groups, setGroups] = useState(() => proposal.groups.map(g => ({ ...g, on: true, skip: new Set<string>(), name: g.final_name })));
  const [error, setError] = useState('');
  const describe = (x: TestEntry) => `${x.name} · ${tn(x.count, '{n} value', '{n} values')}${x.units.length ? ` · ${x.units.join(', ')}` : ''}`;

  const confirm = async () => {
    setState('working'); setError('');
    try {
      for (const g of groups) {
        if (!g.on) continue;
        for (const f of g.from.filter(x => !g.skip.has(x.canonical))) await api.chat.run({ method: 'POST', path: '/api/measurements/merge', body: { from: f.canonical, into: g.into.canonical } });
        const name = g.name.trim();
        if (name && name.toLowerCase() !== g.into.canonical.toLowerCase()) await api.chat.run({ method: 'POST', path: '/api/measurements/rename', body: { from: g.into.canonical, to: name } });
      }
      setState('done');
      announceChange();
    } catch (err) {
      setState('waiting');
      setError(err instanceof Error ? err.message : t('Could not make this change.'));
    }
  };

  return shell(
    tn(groups.length, 'Merge names of the same test ({n} group)', 'Merge names of the same test ({n} groups)'),
    <div className="space-y-3">
      {groups.map((g, i) => {
        const units = new Set([g.into, ...g.from.filter(x => !g.skip.has(x.canonical))].flatMap(x => x.units));
        return (
          <div key={g.into.canonical} className={`rounded-lg border border-gray-200 bg-white p-2.5 ${g.on ? '' : 'opacity-50'}`}>
            <label className="mb-1.5 flex items-center gap-2 font-medium"><input type="checkbox" checked={g.on} disabled={state !== 'waiting'} onChange={e => setGroups(prev => prev.map((x, n) => n === i ? { ...x, on: e.target.checked } : x))} />{t('Merge this group')}</label>
            <ul className="mb-2 space-y-0.5 text-gray-600">
              <li className="break-words"><strong className="font-semibold">{t('Kept')}:</strong> {describe(g.into)}</li>
              {g.from.map(x => (
                <li key={x.canonical} className="flex gap-2 break-words">
                  <input type="checkbox" checked={!g.skip.has(x.canonical)} disabled={state !== 'waiting' || !g.on} aria-label={t('Fold into the kept test')}
                    onChange={e => setGroups(prev => prev.map((y, n) => n === i ? { ...y, skip: new Set(e.target.checked ? [...y.skip].filter(c => c !== x.canonical) : [...y.skip, x.canonical]) } : y))} />
                  <span>{describe(x)}</span>
                </li>
              ))}
            </ul>
            {units.size > 1 && <p className="mb-2 text-amber-700">{t('These carry different units ({units}). Merge them only if they are the same measurement; the trend would mix the values.', { units: [...units].join(', ') })}</p>}
            <p className="mb-1 text-gray-500">{t('Final name, for all of them')}</p>
            <input className={field} value={g.name} onChange={e => setGroups(prev => prev.map((x, n) => n === i ? { ...x, name: e.target.value } : x))} maxLength={120} aria-label={t('Name')} disabled={!g.on} />
          </div>
        );
      })}
      {error && <p className="text-red-600" role="alert">{error}</p>}
    </div>,
    <div className="mt-3 flex gap-2">
      <button type="button" disabled={state === 'working' || !groups.some(g => g.on)} onClick={() => void confirm()} className={primary}>{state === 'working' ? t('Working…') : t('Confirm')}</button>
      <button type="button" disabled={state === 'working'} onClick={() => setState('cancelled')} className={quiet}>{t('Cancel')}</button>
    </div>,
  );
}

/**
 * Groups of pages found to belong together. Each is shown as the new document it would make, with its pages (small pictures, so the
 * person can see for themselves), what the model said and why, and which documents the pages come from now. A group can be left out,
 * and a page taken out of a group (it then stays where it is). Confirm makes the groups that are kept, then reads the changed
 * documents again from the text they now hold.
 */
function RegroupCard({ proposal, state, setState, shell }: { proposal: Extract<Proposal, { kind: 'regroup' }>; state: CardState; setState: (s: CardState) => void; shell: Shell }) {
  const { t, tn } = useI18n();
  const [groups, setGroups] = useState(() => proposal.groups.map(g => ({ ...g, on: g.status === 'validated', pages: g.page_ids.map((id, i) => ({ id, number: g.page_numbers[i] })) })));
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const kept = groups.filter(g => g.on && g.pages.length > 0);

  const confirm = async () => {
    setState('working'); setError(''); setNote('');
    try {
      const made = await api.chat.run<{ touched: string[] }>({ method: 'POST', path: `/api/source-files/${proposal.upload.id}/regroup`, body: { groups: kept.map(g => g.pages.map(p => p.id)) } });
      announceChange();
      try {
        if (made.touched.length > 0) await api.chat.run({ method: 'POST', path: `/api/source-files/${proposal.upload.id}/extract`, body: { document_ids: made.touched } });
      } catch {
        // The grouping stands; only the second step failed, and the grouping screen can read the documents again.
        setNote(t('The pages were regrouped, but reading the changed documents again failed. Use “Read again” on the Pages and grouping screen.'));
      }
      setState('done');
      announceChange();
    } catch (err) {
      setState('waiting');
      setError(err instanceof Error ? err.message : t('Could not make this change.'));
    }
  };

  const badge = (status: 'validated' | 'uncertain' | 'unchecked', confidence: number) => status === 'validated'
    ? <span className="rounded bg-green-100 px-1.5 text-green-800">{t('confirmed by the model')} · {Math.round(confidence * 100)}%</span>
    : status === 'uncertain' ? <span className="rounded bg-amber-100 px-1.5 text-amber-800">{t('uncertain')} · {Math.round(confidence * 100)}%</span>
    : <span className="rounded bg-gray-100 px-1.5 text-gray-700">{t('not checked')}</span>;

  return shell(
    tn(proposal.groups.length, 'Regroup the pages ({n} new document)', 'Regroup the pages ({n} new documents)'),
    <div className="space-y-3">
      {groups.map((g, gi) => (
        <div key={g.label} className={`rounded-lg border border-gray-200 bg-white p-2.5 ${g.on ? '' : 'opacity-50'}`}>
          <label className="mb-1 flex flex-wrap items-center gap-2 font-medium">
            <input type="checkbox" checked={g.on} disabled={state !== 'waiting'} onChange={e => setGroups(prev => prev.map((x, n) => n === gi ? { ...x, on: e.target.checked } : x))} />
            <span>{g.title ?? t('A document made of pages {pages}', { pages: g.pages.map(p => p.number).join(', ') })}</span>
            {badge(g.status, g.confidence)}
          </label>
          {g.reason && <p className="mb-1.5 text-gray-600">{g.reason}</p>}
          <div className="flex flex-wrap gap-2">
            {g.pages.map(p => (
              <figure key={p.id} className="relative m-0">
                <DeviceImg src={`/api/pages/${p.id}/image`} alt={t('Page {n}', { n: p.number })} loading="lazy" className="h-24 w-auto rounded border border-gray-200 bg-white" />
                <figcaption className="text-center text-[10px] text-gray-500">{t('Page {n}', { n: p.number })}</figcaption>
                {state === 'waiting' && g.on && (
                  <button type="button" aria-label={t('Leave this page where it is')} title={t('Leave this page where it is')} onClick={() => setGroups(prev => prev.map((x, n) => n === gi ? { ...x, pages: x.pages.filter(q => q.id !== p.id) } : x))}
                    className="absolute right-0.5 top-0.5 rounded bg-white/90 px-1 text-gray-500 shadow hover:text-red-600">×</button>
                )}
              </figure>
            ))}
          </div>
          {g.from.length > 0 && <p className="mt-1.5 text-gray-500">{t('Now in')}: {g.from.map(d => documentTitle(d, t)).join(' · ')}</p>}
        </div>
      ))}
      {note && <p className="text-amber-700">{note}</p>}
      {error && <p className="text-red-600" role="alert">{error}</p>}
      <p className="text-gray-500">{t('Pages you leave out or do not select stay where they are. The documents that change are read again from the text of their pages; your notes and edits on documents that stay are kept.')}</p>
    </div>,
    <div className="mt-3 flex gap-2">
      <button type="button" disabled={state === 'working' || kept.length === 0} onClick={() => void confirm()} className={primary}>{state === 'working' ? t('Working…') : tn(kept.length, 'Make {n} document', 'Make {n} documents')}</button>
      <button type="button" disabled={state === 'working'} onClick={() => setState('cancelled')} className={quiet}>{t('Cancel')}</button>
    </div>,
  );
}

/**
 * Tags, or providers (the clinic or laboratory on documents), written several ways. As for doctors and tests: the variants, the one
 * final name they would all take, editable, with each variant and each group optional. A tag is folded into the kept tag and the kept
 * one renamed; a provider is renamed wherever it appears (the route makes a name another provider has the same entry).
 */
function MergeLibraryCard({ proposal, state, setState, shell }: { proposal: Extract<Proposal, { kind: 'merge_library' }>; state: CardState; setState: (s: CardState) => void; shell: Shell }) {
  const { t, tn } = useI18n();
  const tags = proposal.library === 'tags';
  const [groups, setGroups] = useState(() => proposal.groups.map(g => ({ ...g, on: true, skip: new Set<string>(), name: g.final_name })));
  const [error, setError] = useState('');
  const key = (e: LibraryEntry) => (e.id !== null ? String(e.id) : e.name);

  const confirm = async () => {
    setState('working'); setError('');
    try {
      for (const g of groups) {
        const name = g.name.trim();
        if (!g.on || !name) continue;
        const members = g.merge.filter(m => !g.skip.has(key(m)));
        if (tags) {
          for (const m of members) await api.chat.run({ method: 'POST', path: `/api/tags/${m.id}/merge`, body: { into: g.keep.id } });
          if (name !== g.keep.name) await api.chat.run({ method: 'PATCH', path: `/api/tags/${g.keep.id}`, body: { name } });
        } else {
          for (const m of [g.keep, ...members]) if (m.name !== name) await api.chat.run({ method: 'POST', path: '/api/providers/rename', body: { from: m.name, to: name } });
        }
      }
      setState('done');
      announceChange();
    } catch (err) {
      setState('waiting');
      setError(err instanceof Error ? err.message : t('Could not make this change.'));
    }
  };

  return shell(
    tags ? tn(groups.length, 'Merge duplicate tags ({n} group)', 'Merge duplicate tags ({n} groups)') : tn(groups.length, 'Merge duplicate providers ({n} group)', 'Merge duplicate providers ({n} groups)'),
    <div className="space-y-3">
      {groups.map((g, i) => (
        <div key={key(g.keep)} className={`rounded-lg border border-gray-200 bg-white p-2.5 ${g.on ? '' : 'opacity-50'}`}>
          <label className="mb-1.5 flex items-center gap-2 font-medium"><input type="checkbox" checked={g.on} disabled={state !== 'waiting'} onChange={e => setGroups(prev => prev.map((x, n) => n === i ? { ...x, on: e.target.checked } : x))} />{t('Merge this group')}</label>
          <ul className="mb-2 space-y-0.5 text-gray-600">
            <li className="break-words"><strong className="font-semibold">{t('Kept')}:</strong> {g.keep.name} · {tn(g.keep.count, '{n} document', '{n} documents')}</li>
            {g.merge.map(m => (
              <li key={key(m)} className="flex gap-2 break-words">
                <input type="checkbox" checked={!g.skip.has(key(m))} disabled={state !== 'waiting' || !g.on} aria-label={t('Fold into the kept entry')}
                  onChange={e => setGroups(prev => prev.map((x, n) => n === i ? { ...x, skip: new Set(e.target.checked ? [...x.skip].filter(k => k !== key(m)) : [...x.skip, key(m)]) } : x))} />
                <span>{m.name} · {tn(m.count, '{n} document', '{n} documents')}</span>
              </li>
            ))}
          </ul>
          <p className="mb-1 text-gray-500">{t('Final name, for all of them')}</p>
          <input className={field} value={g.name} onChange={e => setGroups(prev => prev.map((x, n) => n === i ? { ...x, name: e.target.value } : x))} maxLength={tags ? 60 : 200} aria-label={t('Name')} disabled={!g.on} />
        </div>
      ))}
      {error && <p className="text-red-600" role="alert">{error}</p>}
    </div>,
    <div className="mt-3 flex gap-2">
      <button type="button" disabled={state === 'working' || !groups.some(g => g.on)} onClick={() => void confirm()} className={primary}>{state === 'working' ? t('Working…') : t('Confirm')}</button>
      <button type="button" disabled={state === 'working'} onClick={() => setState('cancelled')} className={quiet}>{t('Cancel')}</button>
    </div>,
  );
}
