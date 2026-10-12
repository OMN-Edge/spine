import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type Document, type DocumentTypeGuide, type ExtractedField, type Page } from '../api';
import PageImageOverlay, { type Highlight } from '../components/PageImageOverlay';
import { MeasurementsEditor, MeasurementsList, draftMeasurement, type DraftMeasurement } from '../components/MeasurementsPanel';
import { DoctorsEditor, DoctorsList, draftDoctor, type DraftDoctor } from '../components/DoctorsPanel';
import { AiReadButton, AiReadingBanner, AiReadingProvider, ExtractAgainButton, useAiReading } from '../components/AiReading';
import PageTextPanel from '../components/PageTextPanel';
import { sourceLabel } from '../components/pageSource';
import { DOC_TYPE_NAMES, documentByline, documentTitle } from '../titles';

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
  const { busy } = useAiReading();
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={busy ? 'Wait for the reading to finish' : undefined}
      className="mt-4 w-full bg-blue-600 text-white rounded-xl px-4 py-2.5 font-medium text-sm hover:bg-blue-700 disabled:opacity-50"
    >
      Review
    </button>
  );
}

/** What to say when nothing was read from a page, which depends on whether the model may be used for it. */
function EmptyPage({ canRead }: { canRead: boolean }) {
  const { target } = useAiReading();
  return (
    <>
      <p className="font-medium text-gray-800">Nothing was read from this page.</p>
      {target ? (
        <>
          <p>
            Pages with no text are normally sent to the model when the file is uploaded, but this one was not (or that reading
            failed). {canRead ? 'Use “Read this page with AI” above to have the model read it now.' : 'Finish reviewing, then you can have the model read it.'}
          </p>
        </>
      ) : (
        <p>
          This server does not send page images to the model, so a scan with no text layer stays empty. The operator can turn that on
          (see the setup guide); until then the scan itself is the only record of the page.
        </p>
      )}
    </>
  );
}

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null); // non-null exactly while editing
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hoveredField, setHoveredField] = useState<Highlight | null>(null);
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
    setDraft(null); setNotice(''); setError(''); setHoveredField(null); setCurrentPageIdx(0); setView('scan');
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

  const editingNow = draft !== null;
  useEffect(() => {
    if (!editingNow) return;
    // Suggestions only: if either call fails, editing works without them.
    api.doctors.list().then(list => setKnownDoctors(list.map(d => d.name))).catch(() => {});
    api.documentTypes().then(setGuides).catch(() => {});
  }, [editingNow]);

  // Hovering (or focusing) a field shows its page and where on it the text was read.
  useEffect(() => {
    if (!hoveredField || !doc?.pages) return;
    const idx = doc.pages.findIndex(p => p.id === hoveredField.page_id);
    if (idx >= 0) setCurrentPageIdx(idx);
  }, [hoveredField, doc?.pages]);

  if (loading) return <p className="text-gray-400 text-sm">Loading…</p>;
  if (!doc) return <p className="text-red-500 text-sm">Document not found</p>;

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
      setError('Every field needs both a label and a value. Remove a field you do not want.');
      return;
    }
    const measurements = doc.measurements ?? [];
    const keptM = draft.measurements.filter(m => !m.removed && (m.id || m.name.trim() || m.value.trim()));
    if (keptM.some(m => !m.name.trim() || !m.value.trim())) {
      setError('Every measurement needs both a test name and a value. Remove one you do not want.');
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
      setNotice('Saved, and marked as reviewed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const renderField = (field: ExtractedField) => (
    <div
      key={field.id}
      onMouseEnter={() => setHoveredField(field)}
      onMouseLeave={() => setHoveredField(null)}
      className={`flex items-start justify-between gap-3 p-2 text-xs ${fieldRowClass(field)}`}
    >
      <span className="font-medium text-gray-500 shrink-0">{field.label}</span>
      <span className="text-gray-900 text-right break-words min-w-0">{field.value}</span>
      {field.bbox_x0 === null && <span className="text-gray-300" title="Source not pinpointed">◌</span>}
    </div>
  );

  const fieldRowClass = (f: Highlight | undefined) =>
    `rounded-lg transition-colors ${f && hoveredField?.id === f.id ? 'bg-yellow-50 border border-yellow-200' : 'border border-transparent hover:bg-gray-50'}`;

  return (
    <AiReadingProvider sourceFileId={doc.source_file_id} onFinished={() => { load(); }}>
    <div className="flex flex-col md:flex-row gap-6 md:h-[calc(100vh-8rem)]">
      {/* Left panel */}
      <div className="w-full md:w-96 shrink-0 md:overflow-y-auto flex flex-col gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <button onClick={() => navigate(-1)} className="text-xs text-gray-400 hover:text-gray-600 mb-3">← Back</button>

          {!editing ? (
            <>
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h1 className="text-lg font-semibold text-gray-900 break-words min-w-0">{documentTitle(doc)}</h1>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${reviewed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                  {reviewed ? 'Reviewed' : 'Unreviewed'}
                </span>
              </div>
              <p className="text-sm text-gray-500">{documentByline(doc)}</p>
              {(doc.tags ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {doc.tags!.map(t => <span key={t} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{t}</span>)}
                </div>
              )}
              {doc.ai_summary && <p className="text-sm text-gray-700 leading-relaxed mt-4">{doc.ai_summary}</p>}
              {doc.user_notes && (
                <div className="mt-4">
                  <p className={label}>Notes</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{doc.user_notes}</p>
                </div>
              )}
              {notice && <p className="text-sm text-green-700 mt-4" role="status">{notice}</p>}
              <ReviewButton onClick={startEditing} />
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-gray-900 mb-4">Review</h1>
              <div className="mb-3">
                <label htmlFor="d-title" className={label}>Title</label>
                <input id="d-title" className={input} value={draft.title} onChange={e => set({ title: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label htmlFor="d-date" className={label}>Date</label>
                  <input id="d-date" type="date" className={input} value={draft.doc_date} onChange={e => set({ doc_date: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="d-type" className={label}>Type</label>
                  <select id="d-type" className={input} value={draft.doc_type} onChange={e => set({ doc_type: e.target.value })}>
                    {Object.entries(DOC_TYPE_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                  </select>
                </div>
              </div>
              <div className="mb-3">
                <label htmlFor="d-provider" className={label}>Provider</label>
                <input id="d-provider" className={input} value={draft.provider} onChange={e => set({ provider: e.target.value })} />
              </div>
              <div className="mb-3">
                <label htmlFor="d-tags" className={label}>Tags (separated by commas)</label>
                <input id="d-tags" className={input} value={draft.tags} onChange={e => set({ tags: e.target.value })} />
              </div>
              <div className="mb-3">
                <label htmlFor="d-summary" className={label}>Summary</label>
                <textarea id="d-summary" rows={4} className={`${input} resize-y`} value={draft.ai_summary} onChange={e => set({ ai_summary: e.target.value })} />
              </div>
              <div>
                <label htmlFor="d-notes" className={label}>Notes</label>
                <textarea id="d-notes" rows={3} className={`${input} resize-y`} placeholder="Personal notes…" value={draft.user_notes} onChange={e => set({ user_notes: e.target.value })} />
              </div>
            </>
          )}
        </div>

        {/* Who the document names */}
        {(editing || (doc.doctors ?? []).length > 0) && (
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <h2 className="font-medium text-gray-900 mb-3 text-sm">Doctors</h2>
            {!editing ? <DoctorsList doctors={doc.doctors ?? []} /> : (
              <DoctorsEditor
                rows={draft.doctors} known={knownDoctors} listId="known-doctors"
                onChange={setDoctor} onAdd={addDoctor} onRemove={removeDoctor}
              />
            )}
          </div>
        )}

        {/* Lab values and vitals: these are what the trends are drawn from */}
        {(editing || (doc.measurements ?? []).length > 0) && (
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <h2 className="font-medium text-gray-900 mb-3 text-sm">Measurements</h2>
            {!editing ? <MeasurementsList items={doc.measurements ?? []} onHover={m => setHoveredField(m)} /> : (
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
              {[...new Set(guides.filter(g => g.type === draft.doc_type).flatMap(g => [...g.fields, ...g.grouped]))].map(l => <option key={l} value={l} />)}
            </datalist>
            <datalist id="measurement-names">
              {[...new Set((doc.measurements ?? []).map(m => m.name))].map(n => <option key={n} value={n} />)}
            </datalist>
          </>
        )}

        {/* Extracted fields */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h2 className="font-medium text-gray-900 mb-3 text-sm">Extracted fields</h2>

          {!editing ? (
            fields.length === 0 ? (
              <p className="text-xs text-gray-400">No fields extracted</p>
            ) : (
              <div className="space-y-1">
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
                      onFocus={() => source && setHoveredField(source)}
                      onBlur={() => setHoveredField(null)}
                      onMouseEnter={() => source && setHoveredField(source)}
                      onMouseLeave={() => setHoveredField(null)}
                      className={`p-2 ${fieldRowClass(source)}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <input
                          aria-label="Field label" placeholder="Label" list="field-labels" className={`${input} font-medium`}
                          value={f.label} onChange={e => setField(f.key, { label: e.target.value })}
                        />
                        <button
                          type="button" onClick={() => setField(f.key, { removed: true })}
                          aria-label={`Remove ${f.label || 'this field'}`}
                          className="shrink-0 h-8 w-8 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
                        >
                          <svg viewBox="0 0 24 24" className="h-4 w-4 mx-auto" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                      </div>
                      <textarea
                        aria-label="Field value" placeholder="Value" rows={2} className={`${input} resize-y`}
                        value={f.value} onChange={e => setField(f.key, { value: e.target.value })}
                      />
                      {!f.id && pages.length > 1 && (
                        <select
                          aria-label="Page this field is on" className={`${input} mt-1`}
                          value={f.page_id} onChange={e => setField(f.key, { page_id: e.target.value })}
                        >
                          {pages.map(p => <option key={p.id} value={p.id}>Page {p.page_number}</option>)}
                        </select>
                      )}
                    </li>
                  );
                })}
              </ul>
              {draft.fields.every(f => f.removed) && <p className="text-xs text-gray-400">No fields</p>}
              <button
                type="button" onClick={addField} disabled={pages.length === 0}
                className="mt-3 text-sm text-blue-600 hover:underline disabled:opacity-50"
              >
                + Add a field
              </button>
              {draft.fields.some(f => f.removed) && (
                <p className="text-xs text-gray-400 mt-2">
                  {draft.fields.filter(f => f.removed).length} removed.{' '}
                  <button type="button" className="text-blue-600 hover:underline" onClick={() => setDraft(d => (d ? { ...d, fields: d.fields.map(f => ({ ...f, removed: false })) } : d))}>
                    Undo
                  </button>
                </p>
              )}
            </>
          )}
        </div>

        {/* Reading again replaces what is extracted, so not while there are unsaved edits. */}
        {!editing && (
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <h2 className="font-medium text-gray-900 text-sm">Read again</h2>
            <p className="text-xs text-gray-500">Details look wrong? Extract them again from the text already read.</p>
            <ExtractAgainButton
              documentId={doc.id}
              reviewed={reviewed}
              onDone={result => {
                setNotice(result === 'failed'
                  ? 'The details could not be extracted again, so they are as they were.'
                  : 'Extracted again. The document is waiting in Review.');
                load();
              }}
            />
          </div>
        )}

        {editing && (
          <div className="sticky bottom-0 -mx-4 sm:mx-0 bg-gray-50/95 backdrop-blur px-4 sm:px-0 py-3 border-t border-gray-200 sm:border-0 flex flex-col gap-2">
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={done} disabled={saving}
                className="flex-1 bg-blue-600 text-white rounded-xl px-4 py-2.5 font-medium text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Done'}
              </button>
              <button
                onClick={discard} disabled={saving}
                className="px-4 py-2.5 rounded-xl text-sm text-gray-600 border border-gray-300 hover:bg-white disabled:opacity-50"
              >
                Discard changes
              </button>
            </div>
            <p className="text-xs text-gray-400">Done saves everything here and marks the document reviewed.</p>
          </div>
        )}

        {!editing && (
          <Link to="/review" className="text-xs text-gray-400 hover:text-gray-600">Review queue →</Link>
        )}
      </div>

      {/* Right panel — page images */}
      <div className="flex-1 min-w-0 md:overflow-y-auto">
        {pages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <p>No page images available yet</p>
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
                      className={`text-xs px-2 py-1 rounded ${i === currentPageIdx ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'}`}
                    >
                      {p.page_number}
                    </button>
                  ))}
                </div>
              )}
              <div role="group" aria-label="Show" className="ml-auto flex rounded-lg border border-gray-200 bg-white overflow-hidden text-xs">
                {(['scan', 'text'] as const).map(v => (
                  <button
                    key={v}
                    type="button" aria-pressed={view === v} onClick={() => setView(v)}
                    className={`px-3 py-1 ${view === v ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                  >
                    {v === 'scan' ? 'Scan' : 'Text'}
                  </button>
                ))}
              </div>
            </div>

            {currentPage && (
              <div className="mb-3 space-y-2">
                <p className="text-xs text-gray-500 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    Page {currentPage.page_number}: text{' '}
                    <span className={`font-medium ${currentPage.extraction_source === 'multimodal' ? 'text-purple-700' : 'text-gray-700'}`}>
                      read by {sourceLabel(currentPage.extraction_source)}
                    </span>
                  </span>
                  {!editing && (
                    <AiReadButton
                      pageIds={[currentPage.id]}
                      label="Read this page with AI"
                      documents={1}
                      reviewed={reviewed ? 1 : 0}
                    />
                  )}
                </p>
                <AiReadingBanner />
              </div>
            )}

            {currentPage && view === 'scan' && <PageImageOverlay page={currentPage} highlightField={hoveredField} />}
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
