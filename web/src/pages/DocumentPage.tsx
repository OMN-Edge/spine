import { useCallback, useEffect, useState } from 'react';
import { useOnDataChanged } from '../dataChanged';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type Document, type DocumentTypeGuide, type ExtractedField, type Page } from '../api';
import PageImageOverlay, { type Highlight } from '../components/PageImageOverlay';
import { MeasurementsEditor, MeasurementsList, draftMeasurement, type DraftMeasurement } from '../components/MeasurementsPanel';
import { DoctorsEditor, DoctorsList, draftDoctor, type DraftDoctor } from '../components/DoctorsPanel';
import { AiReadingBanner, AiReadingProvider, useAiReading } from '../components/AiReading';
import ReadAgainMenu from '../components/ReadAgainMenu';
import { SOURCE_CHIP } from '../components/pageSource';
import PageTextPanel from '../components/PageTextPanel';
import RelatedDocuments from '../components/RelatedDocuments';
import CareChain from '../components/CareChain';
import { useScreen } from '../components/ChatProvider';
import { DOC_TYPE_NAMES, documentByline, documentTitle, fieldName, isSection, labelFromName, valueLines } from '../titles';
import { LANGUAGES, useI18n } from '../i18n';
import { languageName, useTranslation } from '../i18n/useTranslation';

/**
 * A document, in two modes on the same page. Reading shows what was extracted next to the
 * scans. **Review** turns every part of it into something you can edit in place — the
 * details, the tags and each extracted field — and **Done** saves it all in one go, marks
 * the document reviewed, and goes back to reading. Review again to edit again.
 *
 * Opening a document from the review queue starts in edit mode (`?edit=1`); from anywhere
 * else it starts in reading mode.
 */

interface DraftField {
  /** Stable while editing: the field's id, or a made-up one for a new row. */
  key: string;
  id?: string;
  label: string;
  value: string;
  page_id: string;
  removed: boolean;
}

interface Draft {
  title: string;
  doc_date: string;
  provider: string;
  doc_type: string;
  ai_summary: string;
  user_notes: string;
  language: string;
  tags: string;
  fields: DraftField[];
  measurements: DraftMeasurement[];
  doctors: DraftDoctor[];
}

const input = 'w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500';
const label = 'block text-xs font-medium text-gray-500 mb-1';

const draftOf = (doc: Document): Draft => ({
  title: doc.title ?? '',
  doc_date: doc.doc_date ?? '',
  provider: doc.provider ?? '',
  doc_type: doc.doc_type ?? 'other',
  ai_summary: doc.ai_summary ?? '',
  user_notes: doc.user_notes ?? '',
  language: doc.language ?? '',
  tags: (doc.tags ?? []).join(', '),
  fields: (doc.fields ?? []).map(f => ({ key: f.id, id: f.id, label: f.label, value: f.value, page_id: f.page_id, removed: false })),
  measurements: (doc.measurements ?? []).map(draftMeasurement),
  doctors: (doc.doctors ?? []).map(draftDoctor),
});

/** The fields that share a group number, in the order the groups first appear. */
const groupsOf = (fields: ExtractedField[]): Array<[number, ExtractedField[]]> => {
  const groups = new Map<number, ExtractedField[]>();
  for (const f of fields) if (f.group_no !== null) groups.set(f.group_no, [...(groups.get(f.group_no) ?? []), f]);
  return [...groups.entries()];
};

const parseTags = (text: string) => [...new Set(text.split(',').map(t => t.trim()).filter(Boolean))];

/** The Review button, held while a reading is running: it would be editing text that is about to change. */
function ReviewButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  const { busy } = useAiReading();
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={busy ? t('Wait for the reading to finish') : undefined}
      className="flex-1 bg-blue-600 text-white rounded-xl px-4 py-2.5 font-medium text-sm hover:bg-blue-700 disabled:opacity-50"
    >
      {t('Review')}
    </button>
  );
}

/** What to say when nothing was read from a page, which depends on whether the model may be used for it. */
function EmptyPage({ canRead }: { canRead: boolean }) {
  const { t } = useI18n();
  const { target } = useAiReading();
  return (
    <>
      <p className="font-medium text-gray-800">{t('Nothing was read from this page.')}</p>
      {target ? (
        <>
          <p>
            {t('Pages with no text are normally sent to the model when the file is uploaded, but this one was not (or that reading failed).')} {canRead ? t('Use Read again, then Read page with AI, to have the model read it now.') : t('Finish reviewing, then you can have the model read it.')}
          </p>
        </>
      ) : (
        <p>
          {t('This server does not send page images to the model, so a scan with no text layer stays empty. The operator can turn that on (see the setup guide); until then the scan itself is the only record of the page.')}
        </p>
      )}
    </>
  );
}

export default function DocumentPage() {
  const { t, lang } = useI18n();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null); // non-null exactly while editing
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedField, setSelectedField] = useState<Highlight | null>(null);
  // Offered while editing: the doctors already in the directory, and what each type of document usually holds.
  const [knownDoctors, setKnownDoctors] = useState<string[]>([]);
  const [guides, setGuides] = useState<DocumentTypeGuide[]>([]);
  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  // What the right panel shows for the page: the scan, or the text read from it.
  const [view, setView] = useState<'scan' | 'text'>('scan');

  const load = useCallback(async () => {
    if (!id) return;
    const loaded = await api.documents.get(id);
    setDoc(loaded);
    return loaded;
  }, [id]);

  useEffect(() => {
    // A different document: nothing of the last one (its draft, notice, page) carries over.
    setDraft(null); setNotice(''); setError(''); setSelectedField(null); setCurrentPageIdx(0); setView('scan');
    load()
      .then(loaded => {
        if (!loaded) return;
        if (params.get('edit') === '1') setDraft(draftOf(loaded));
        // ?page=N opens at that page, as from the grouping screen's preview.
        const at = loaded.pages?.findIndex(p => p.page_number === Number(params.get('page'))) ?? -1;
        if (at >= 0) setCurrentPageIdx(at);
      })
      .finally(() => setLoading(false));
    // Only the first load decides the starting mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // A change made from the chat (a note, a correction): read the document again, unless the person is editing it.
  useOnDataChanged(() => { if (draft === null) void load(); });

  const editingNow = draft !== null;
  useEffect(() => {
    if (!editingNow) return;
    // Suggestions only: if either call fails, editing works without them.
    api.doctors.list().then(list => setKnownDoctors(list.map(d => d.name))).catch(() => {});
    api.documentTypes().then(setGuides).catch(() => {});
  }, [editingNow]);

  // Clicking a field (or a result) selects it: its page comes up, and where on it the text was read is
  // drawn there, until another is clicked, the same one is clicked again, or Escape is pressed. Nothing
  // follows the mouse, so the highlight can be looked at.
  useEffect(() => {
    if (!selectedField) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedField(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedField]);

  useEffect(() => {
    if (!selectedField || !doc?.pages) return;
    const idx = doc.pages.findIndex(p => p.id === selectedField.page_id);
    if (idx >= 0) setCurrentPageIdx(idx);
  }, [selectedField, doc?.pages]);

  // The chat knows what is on this page: the document, whether it is being edited, and the field or result picked.
  useScreen(doc ? { page: 'document', documentId: doc.id, editing: draft !== null, selectedId: selectedField?.id, pageNumber: doc.pages?.[currentPageIdx]?.page_number } : null);

  // A link from the chat (or anywhere) can point at a part of the page: ?section=results scrolls there and lights it briefly.
  // Run again for the same part when the link is followed again, which is why the location's key is a dependency.
  useEffect(() => {
    const section = new URLSearchParams(location.search).get('section');
    if (!section || loading || !doc) return;
    const el = document.getElementById(`section-${section}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('ring-2', 'ring-blue-400');
    const timer = window.setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400'), 2200);
    return () => { window.clearTimeout(timer); el.classList.remove('ring-2', 'ring-blue-400'); };
  }, [location.key, location.search, loading, doc?.id]);

  // The document in the reader's language, once the model has had it; until then (and when it is already in that
  // language) the original shows. Not while editing: an edit is made to what was read, not to a translation of it.
  const needsTranslation = !!doc && !draft && doc.language !== lang;
  const tr = useTranslation(
    needsTranslation && doc ? `${doc.id}|${doc.title}|${doc.ai_summary}|${doc.user_notes}|${(doc.fields ?? []).map(f => f.id + f.value).join()}` : null,
    (l, part) => api.documents.translation(doc!.id, l, part),
  );

  if (loading) return <p className="text-gray-400 text-sm">{t('Loading…')}</p>;
  if (!doc) return <p className="text-red-500 text-sm">{t('Document not found')}</p>;
  const shown = tr.showing ? tr.translation : null;
  const title = shown?.title ?? doc.title;
  const summary = shown?.ai_summary ?? doc.ai_summary;
  const notes = shown?.user_notes ?? doc.user_notes;
  // A section pulses until its own part has arrived: the title, summary, notes and specialties come first, the fields and results after.
  const waitingHead = needsTranslation && tr.translating && !tr.translation;
  const waitingBody = needsTranslation && tr.translating && tr.translation?.part !== 'full';
  const pulse = (waiting: boolean) => (waiting ? 'animate-pulse motion-reduce:animate-none' : '');

  const pages: Page[] = doc.pages ?? [];
  const fields: ExtractedField[] = doc.fields ?? [];
  const currentPage = pages[currentPageIdx];
  const editing = draft !== null;
  const reviewed = !!doc.reviewed;

  const set = (patch: Partial<Draft>) => setDraft(d => (d ? { ...d, ...patch } : d));
  const setField = (key: string, patch: Partial<DraftField>) =>
    setDraft(d => (d ? { ...d, fields: d.fields.map(f => (f.key === key ? { ...f, ...patch } : f)) } : d));

  const setMeasurement = (key: string, patch: Partial<DraftMeasurement>) =>
    setDraft(d => (d ? { ...d, measurements: d.measurements.map(m => (m.key === key ? { ...m, ...patch } : m)) } : d));
  const addMeasurement = () =>
    setDraft(d => (d ? {
      ...d,
      measurements: [...d.measurements, {
        key: `new-${Date.now()}-${d.measurements.length}`, name: '', canonical: '', value: '', unit: '', ref_low: '', ref_high: '',
        taken_on: d.doc_date, page_id: currentPage?.id ?? pages[0]?.id ?? '', removed: false,
      }],
    } : d));
  const setDoctor = (key: string, patch: Partial<DraftDoctor>) =>
    setDraft(d => (d ? { ...d, doctors: d.doctors.map(x => (x.key === key ? { ...x, ...patch } : x)) } : d));
  const addDoctor = () =>
    setDraft(d => (d ? { ...d, doctors: [...d.doctors, { key: `new-${Date.now()}-${d.doctors.length}`, name: '', specialty: '', role: 'author' }] } : d));
  const removeDoctor = (key: string) => setDraft(d => (d ? { ...d, doctors: d.doctors.filter(x => x.key !== key) } : d));

  const startEditing = () => { setError(''); setNotice(''); setDraft(draftOf(doc)); };
  const discard = () => { setError(''); setDraft(null); };

  const addField = () =>
    setDraft(d => (d ? {
      ...d,
      fields: [...d.fields, { key: `new-${Date.now()}-${d.fields.length}`, label: '', value: '', page_id: currentPage?.id ?? pages[0]?.id ?? '', removed: false }],
    } : d));

  const done = async () => {
    if (!draft) return;
    const kept = draft.fields.filter(f => !f.removed);
    // A blank new row is just an unused row; a half-filled one, or a blanked existing field, is a mistake.
    const rows = kept.filter(f => f.id || f.label.trim() || f.value.trim());
    if (rows.some(f => !f.label.trim() || !f.value.trim())) {
      setError(t('Every field needs both a label and a value. Remove a field you do not want.'));
      return;
    }
    const measurements = doc.measurements ?? [];
    const keptM = draft.measurements.filter(m => !m.removed && (m.id || m.name.trim() || m.value.trim()));
    if (keptM.some(m => !m.name.trim() || !m.value.trim())) {
      setError(t('Every measurement needs both a test name and a value. Remove one you do not want.'));
      return;
    }
    const originalM = new Map(measurements.map(m => [m.id, draftMeasurement(m)]));
    const asInput = (m: DraftMeasurement) => ({
      name: m.name.trim(), canonical: m.canonical, value: m.value.trim(), unit: m.unit.trim() || null,
      ref_low: m.ref_low.trim() || null, ref_high: m.ref_high.trim() || null, taken_on: m.taken_on || null,
    });
    const changedM = (m: DraftMeasurement) => {
      const o = originalM.get(m.id!)!;
      return JSON.stringify(asInput(m)) !== JSON.stringify(asInput({ ...o, canonical: m.canonical }));
    };

    const keptD = draft.doctors.filter(d => d.name.trim());
    const doctorList = (list: Array<{ name: string; specialty: string | null | ''; role: string }>) =>
      JSON.stringify(list.map(d => [d.name.trim(), d.specialty || null, d.role]));
    const doctorsChanged = doctorList(keptD) !== doctorList(doc.doctors ?? []);

    const original = new Map(fields.map(f => [f.id, f]));
    setSaving(true);
    setError('');
    try {
      await api.documents.update(doc.id, {
        title: draft.title,
        doc_date: draft.doc_date,
        provider: draft.provider,
        doc_type: draft.doc_type,
        ai_summary: draft.ai_summary,
        user_notes: draft.user_notes,
        language: draft.language || null,
        tags: parseTags(draft.tags),
        reviewed: true,
        measurements: {
          update: keptM.filter(m => m.id && changedM(m)).map(m => ({ id: m.id!, ...asInput(m) })),
          remove: draft.measurements.filter(m => m.removed && m.id).map(m => m.id!),
          add: keptM.filter(m => !m.id).map(m => ({ ...asInput(m), page_id: m.page_id })),
        },
        ...(doctorsChanged ? { doctors: keptD.map(d => ({ name: d.name.trim(), specialty: d.specialty.trim() || null, role: d.role })) } : {}),
        fields: {
          update: rows
            .filter(f => f.id && (original.get(f.id)!.label !== f.label.trim() || original.get(f.id)!.value !== f.value.trim()))
            .map(f => ({ id: f.id!, label: f.label.trim(), value: f.value.trim() })),
          remove: draft.fields.filter(f => f.removed && f.id).map(f => f.id!),
          add: rows.filter(f => !f.id).map(f => ({ label: f.label.trim(), value: f.value.trim(), page_id: f.page_id })),
        },
      });
      await load();
      setDraft(null);
      setNotice(t('Saved, and marked as reviewed.'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setSaving(false);
    }
  };

  const renderField = (field: ExtractedField) => {
    // Where it was found: the page. A box on that page is drawn when there is an exact one, and not otherwise.
    const docPages = doc.pages ?? [];
    // The page's place in this document (the first is 1); its place in the file is the tooltip.
    const sourceAt = docPages.length > 1 ? docPages.findIndex(p => p.id === field.page_id) : -1;
    const unpinned = sourceAt >= 0 && (
      <span className="text-[11px] text-gray-400 shrink-0" title={`${t('The page it was found on')} · ${t('Page {n} of the file', { n: docPages[sourceAt].page_number })}`}>{t('p. {n}', { n: sourceAt + 1 })}</span>
    );
    const select = {
      role: 'button' as const,
      tabIndex: 0,
      'aria-pressed': selectedField?.id === field.id,
      onClick: () => setSelectedField(current => (current?.id === field.id ? null : field)),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedField(current => (current?.id === field.id ? null : field)); }
      },
    };
    // A long value is a section: its name on top, the text under it across the full width.
    const said = shown?.fields[field.id];
    const name = said?.label ?? fieldName(field.label, t);
    const value = said?.value ?? field.value;
    if (isSection(value)) {
      const lines = valueLines(field.label, value);
      return (
        <div key={field.id} {...select} className={`p-2 text-xs cursor-pointer ${fieldRowClass(field)}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-gray-500">{name}</span>
            {unpinned}
          </div>
          <div className="mt-1 space-y-1 text-gray-900 leading-relaxed break-words">
            {lines.map((line, i) => <p key={i}>{line}</p>)}
          </div>
        </div>
      );
    }
    return (
      <div key={field.id} {...select} className={`flex items-start justify-between gap-3 p-2 text-xs cursor-pointer ${fieldRowClass(field)}`}>
        <span className="font-medium text-gray-500 shrink-0">{name}</span>
        <span className="text-gray-900 text-right break-words min-w-0">{value}</span>
        {unpinned}
      </div>
    );
  };

  const fieldRowClass = (f: Highlight | undefined) =>
    `rounded-lg transition-colors ${f && selectedField?.id === f.id ? 'bg-yellow-50 border border-yellow-200' : 'border border-transparent hover:bg-gray-50'}`;

  return (
    <AiReadingProvider sourceFileId={doc.source_file_id} onFinished={() => { load(); }}>
    <div className="flex flex-col md:flex-row gap-6 md:h-[calc(100vh-8rem)]">
      {/* Left panel */}
      <div className="w-full md:w-96 shrink-0 md:overflow-y-auto flex flex-col gap-4">
        <div id="section-summary" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
          <button onClick={() => navigate(-1)} className="text-xs text-gray-400 hover:text-gray-600 mb-3">← {t('Back')}</button>

          {doc.grouping_confirmed === false && (
            <div role="status" className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
              {t('How this upload’s pages were grouped has not been confirmed yet, so this document is not in your timeline and cannot be marked reviewed.')}{' '}
              <Link to={`/uploads/${doc.source_file_id}`} className="font-medium text-blue-600 hover:underline">{t('Check the grouping')}</Link>
            </div>
          )}

          {!editing ? (
            <>
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h1 className={`text-lg font-semibold text-gray-900 break-words min-w-0 ${pulse(waitingHead)}`}>{documentTitle({ ...doc, title }, t)}</h1>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${reviewed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                  {reviewed ? t('Reviewed') : t('Unreviewed')}
                </span>
              </div>
              <p className="text-sm text-gray-500">{documentByline(doc, t)}</p>
              {needsTranslation && (tr.translating || tr.active) && (
                <p className="text-xs text-gray-500 mt-1 flex flex-wrap items-center gap-1.5" role="status">
                  {tr.translating && <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />}
                  {tr.translating ? t('Translating…') : t('Translated from {language}.', { language: languageName(tr.translation?.source_language ?? doc.language) || t('the original language') })}{' '}
                  {tr.active && (
                    <button type="button" onClick={() => tr.setShowOriginal(o => !o)} className="text-blue-600 hover:underline">
                      {tr.showOriginal ? t('Show translation') : t('Show original')}
                    </button>
                  )}
                </p>
              )}
              {tr.partial && <p className="text-xs text-gray-400 mt-1">{t('Only part of this document could be translated. The rest is shown in the original.')}</p>}
              {tr.failed && <p className="text-xs text-gray-400 mt-1">{t('Could not translate this document. Showing the original.')}</p>}
              {(doc.tags ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {doc.tags!.map(tag => <span key={tag} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{tag}</span>)}
                </div>
              )}
              {summary && <p className={`text-sm text-gray-700 leading-relaxed mt-4 ${pulse(waitingHead)}`}>{summary}</p>}
              {notes && (
                <div id="section-notes" className="mt-4 rounded-lg transition-shadow">
                  <p className={label}>{t('Notes')}</p>
                  <p className={`text-sm text-gray-700 whitespace-pre-wrap ${pulse(waitingHead)}`}>{notes}</p>
                </div>
              )}
              {notice && <p className="text-sm text-green-700 mt-4" role="status">{notice}</p>}
              {currentPage && SOURCE_CHIP[currentPage.extraction_source ?? ''] && (
                <p className="mt-4 text-xs text-gray-500">
                  {t('Extraction:')}
                  <span
                    title={t(SOURCE_CHIP[currentPage.extraction_source ?? ''].hint)}
                    className={`ml-1.5 rounded-full px-2 py-0.5 font-medium ${SOURCE_CHIP[currentPage.extraction_source ?? ''].style}`}
                  >
                    {t(SOURCE_CHIP[currentPage.extraction_source ?? ''].text)}
                  </span>
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-stretch gap-2">
                <ReviewButton onClick={startEditing} />
                <ReadAgainMenu
                  page={currentPage}
                  pages={pages}
                  reviewed={reviewed}
                />
              </div>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-gray-900 mb-4">{t('Review')}</h1>
              <div className="mb-3">
                <label htmlFor="d-title" className={label}>{t('Title')}</label>
                <input id="d-title" className={input} value={draft.title} onChange={e => set({ title: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label htmlFor="d-date" className={label}>{t('Date')}</label>
                  <input id="d-date" type="date" className={input} value={draft.doc_date} onChange={e => set({ doc_date: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="d-type" className={label}>{t('Type')}</label>
                  <select id="d-type" className={input} value={draft.doc_type} onChange={e => set({ doc_type: e.target.value })}>
                    {Object.entries(DOC_TYPE_NAMES).map(([value, name]) => <option key={value} value={value}>{t(name)}</option>)}
                  </select>
                </div>
              </div>
              <div className="mb-3">
                <label htmlFor="d-provider" className={label}>{t('Provider')}</label>
                <input id="d-provider" className={input} value={draft.provider} onChange={e => set({ provider: e.target.value })} />
              </div>
              <div className="mb-3">
                <label htmlFor="d-tags" className={label}>{t('Tags (separated by commas)')}</label>
                <input id="d-tags" className={input} value={draft.tags} onChange={e => set({ tags: e.target.value })} />
              </div>
              <div className="mb-3">
                <label htmlFor="d-summary" className={label}>{t('Summary')}</label>
                <textarea id="d-summary" rows={4} className={`${input} resize-y`} value={draft.ai_summary} onChange={e => set({ ai_summary: e.target.value })} />
              </div>
              <div className="mb-3">
                <label htmlFor="d-language" className={label}>{t('Written in')}</label>
                <select id="d-language" className={input} value={draft.language} onChange={e => set({ language: e.target.value })}>
                  <option value="">{t('Not known')}</option>
                  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                  {draft.language && !LANGUAGES.some(l => l.code === draft.language) && <option value={draft.language}>{draft.language}</option>}
                </select>
              </div>
              <div>
                <label htmlFor="d-notes" className={label}>{t('Notes')}</label>
                <textarea id="d-notes" rows={3} className={`${input} resize-y`} placeholder={t('Personal notes…')} value={draft.user_notes} onChange={e => set({ user_notes: e.target.value })} />
              </div>
            </>
          )}
        </div>

        {/* Who the document names */}
        {(editing || (doc.doctors ?? []).length > 0) && (
          <div id="section-doctors" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
            <h2 className="font-medium text-gray-900 mb-3 text-sm">{t('Doctors')}</h2>
            {!editing ? <div className={pulse(waitingHead)}><DoctorsList doctors={(doc.doctors ?? []).map(d => (shown && d.id in shown.doctors ? { ...d, specialty: shown.doctors[d.id] } : d))} /></div> : (
              <DoctorsEditor
                rows={draft.doctors} known={knownDoctors} listId="known-doctors"
                onChange={setDoctor} onAdd={addDoctor} onRemove={removeDoctor}
              />
            )}
          </div>
        )}

        {/* Lab values and vitals: these are what the trends are drawn from */}
        {(editing || (doc.measurements ?? []).length > 0) && (
          <div id="section-results" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
            <h2 className="font-medium text-gray-900 mb-3 text-sm">{t('Measurements')}</h2>
            {!editing ? <div className={pulse(waitingBody)}><MeasurementsList items={(doc.measurements ?? []).map(m => ({ ...m, name: shown?.measurements[m.id] ?? m.name }))} selectedId={selectedField?.id} onSelect={m => setSelectedField(current => (current?.id === m.id ? null : m))} /></div> : (
              <MeasurementsEditor
                rows={draft.measurements} pages={pages} currentPageId={currentPage?.id ?? ''} listId="measurement-names"
                onChange={setMeasurement} onAdd={addMeasurement}
              />
            )}
          </div>
        )}

        {editing && (
          <>
            <datalist id="field-labels">
              {[...new Set(guides.filter(g => g.type === draft.doc_type).flatMap(g => [...g.fields, ...g.grouped]))].map(l => <option key={l} value={fieldName(l, t)} />)}
            </datalist>
            <datalist id="measurement-names">
              {[...new Set((doc.measurements ?? []).map(m => m.name))].map(n => <option key={n} value={n} />)}
            </datalist>
          </>
        )}

        {!editing && <div id="section-chain" className="rounded-xl transition-shadow"><CareChain documentId={doc.id} /></div>}
        {!editing && <RelatedDocuments documentId={doc.id} />}

        {/* Extracted fields */}
        <div id="section-fields" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
          <h2 className="font-medium text-gray-900 mb-3 text-sm">{t('Extracted fields')}</h2>

          {!editing ? (
            fields.length === 0 ? (
              <p className="text-xs text-gray-400">{t('No fields extracted')}</p>
            ) : (
              <div className={`space-y-1 ${pulse(waitingBody)}`}>
                {fields.filter(f => f.group_no === null).map(renderField)}
                {/* Fields that belong together (one prescription line) are shown together. */}
                {groupsOf(fields).map(([no, members]) => (
                  <div key={no} className="border border-gray-100 rounded-lg p-1 my-2">
                    {members.map(renderField)}
                  </div>
                ))}
              </div>
            )
          ) : (
            <>
              <ul className="space-y-2">
                {draft.fields.filter(f => !f.removed).map(f => {
                  const source = fields.find(x => x.id === f.id);
                  return (
                    <li
                      key={f.key}
                      onFocus={() => source && setSelectedField(source)}
                      className={`p-2 ${fieldRowClass(source)}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <input
                          aria-label={t('Field label')} placeholder={t('Label')} list="field-labels" className={`${input} font-medium`}
                          value={fieldName(f.label, t)} onChange={e => setField(f.key, { label: labelFromName(e.target.value) })}
                        />
                        <button
                          type="button" onClick={() => setField(f.key, { removed: true })}
                          aria-label={f.label ? t('Remove {name}', { name: fieldName(f.label, t) }) : t('Remove this field')}
                          className="shrink-0 h-8 w-8 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
                        >
                          <svg viewBox="0 0 24 24" className="h-4 w-4 mx-auto" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                      </div>
                      <textarea
                        aria-label={t('Field value')} placeholder={t('Value')} rows={2} className={`${input} resize-y`}
                        value={f.value} onChange={e => setField(f.key, { value: e.target.value })}
                      />
                      {!f.id && pages.length > 1 && (
                        <select
                          aria-label={t('Page this field is on')} className={`${input} mt-1`}
                          value={f.page_id} onChange={e => setField(f.key, { page_id: e.target.value })}
                        >
                          {pages.map((p, i) => <option key={p.id} value={p.id}>{t('Page {n}', { n: i + 1 })}</option>)}
                        </select>
                      )}
                    </li>
                  );
                })}
              </ul>
              {draft.fields.every(f => f.removed) && <p className="text-xs text-gray-400">{t('No fields')}</p>}
              <button
                type="button" onClick={addField} disabled={pages.length === 0}
                className="mt-3 text-sm text-blue-600 hover:underline disabled:opacity-50"
              >
                + {t('Add a field')}
              </button>
              {draft.fields.some(f => f.removed) && (
                <p className="text-xs text-gray-400 mt-2">
                  {t('{n} removed.', { n: draft.fields.filter(f => f.removed).length })}{' '}
                  <button type="button" className="text-blue-600 hover:underline" onClick={() => setDraft(d => (d ? { ...d, fields: d.fields.map(f => ({ ...f, removed: false })) } : d))}>
                    {t('Undo')}
                  </button>
                </p>
              )}
            </>
          )}
        </div>

        {/* Reading again replaces what is extracted, so not while there are unsaved edits. */}
        {editing && (
          <div className="sticky bottom-0 -mx-4 sm:mx-0 bg-gray-50/95 backdrop-blur px-4 sm:px-0 py-3 border-t border-gray-200 sm:border-0 flex flex-col gap-2">
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={done} disabled={saving}
                className="flex-1 bg-blue-600 text-white rounded-xl px-4 py-2.5 font-medium text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? t('Saving…') : t('Done')}
              </button>
              <button
                onClick={discard} disabled={saving}
                className="px-4 py-2.5 rounded-xl text-sm text-gray-600 border border-gray-300 hover:bg-white disabled:opacity-50"
              >
                {t('Discard changes')}
              </button>
            </div>
            <p className="text-xs text-gray-400">{t('Done saves everything here and marks the document reviewed.')}</p>
          </div>
        )}

        {!editing && (
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <Link to="/review" className="text-xs text-gray-400 hover:text-gray-600">{t('Review queue')} →</Link>
            <a href={`/api/documents/${doc.id}/export`} download className="text-xs text-gray-400 hover:text-gray-600" title={t('This document and what was read from it, as a ZIP')}>{t('Export')}</a>
          </div>
        )}
      </div>

      {/* Right panel — page images */}
      <div className="flex-1 min-w-0 md:overflow-y-auto">
        {pages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <p>{t('No page images available yet')}</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {pages.length > 1 && (
                <div className="flex flex-wrap gap-1">
                  {pages.map((p, i) => (
                    <button
                      key={p.id}
                      onClick={() => setCurrentPageIdx(i)}
                      title={p.page_number !== i + 1 ? t('Page {n} of the file', { n: p.page_number }) : undefined}
                      className={`text-xs px-2 py-1 rounded ${i === currentPageIdx ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'}`}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
              )}
              <div role="group" aria-label={t('Show')} className="ml-auto flex rounded-lg border border-gray-200 bg-white overflow-hidden text-xs">
                {(['scan', 'text'] as const).map(v => (
                  <button
                    key={v}
                    type="button" aria-pressed={view === v} onClick={() => setView(v)}
                    className={`px-3 py-1 ${view === v ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                  >
                    {v === 'scan' ? t('Scan') : t('Text')}
                  </button>
                ))}
              </div>
            </div>

            {currentPage && (
              <div className="mb-3 space-y-2">
                <AiReadingBanner />
              </div>
            )}

            {currentPage && view === 'scan' && <PageImageOverlay page={currentPage} number={currentPageIdx + 1} highlightField={selectedField} />}
            {currentPage && view === 'text' && (
              <PageTextPanel
                text={currentPage.raw_text}
                empty={<EmptyPage canRead={!editing} />}
              />
            )}
          </>
        )}
      </div>
    </div>
    </AiReadingProvider>
  );
}
