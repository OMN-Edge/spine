import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type MatchQuestion } from '../api';
import { announceChange } from '../dataChanged';
import type { RegroupNotice, UploadNotice } from '../api';
import { msg, useI18n } from '../i18n';
import { documentTitle } from '../titles';

/**
 * What the app said when an upload had been read, drawn here in the person's language from the facts it stored. The buttons are
 * only questions they could type; whatever they lead to that changes something comes back as a proposal to confirm.
 */
export default function UploadNoticeMessage({ notice, busy, onAsk }: { notice: UploadNotice; busy: boolean; onAsk: (question: string) => void }) {
  const { t, tn } = useI18n();
  const name = notice.file_name ?? t('The upload');
  const chip = 'rounded-full border border-gray-200 px-3 py-1.5 text-left text-xs text-gray-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50';

  if (notice.state === 'failed') {
    return (
      <div className="text-sm text-gray-900">
        <p>{t('“{name}” could not be read. You can try it again from the Upload page.', { name })}</p>
        <p className="mt-2"><Link to="/upload" className="text-blue-600 hover:underline">{t('Go to Upload')}</Link></p>
      </div>
    );
  }

  const count = notice.documents.length + notice.more_documents;
  return (
    <div className="text-sm text-gray-900">
      <p>{t('“{name}” has been read: {documents} from {pages}.', { name, documents: tn(count, '{n} document', '{n} documents'), pages: tn(notice.pages, '{n} page', '{n} pages') })}</p>
      {notice.documents.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
          {notice.documents.map(d => (
            <li key={d.id} className="truncate">· <Link to={`/documents/${d.id}`} className="hover:text-blue-700 hover:underline">{documentTitle(d, t)}</Link>{d.doc_date ? ` (${d.doc_date})` : ''}</li>
          ))}
          {notice.more_documents > 0 && <li>· {tn(notice.more_documents, 'and {n} more', 'and {n} more')}</li>}
        </ul>
      )}
      {(notice.doctors_added.length > 0 || notice.doctors_matched > 0) && (
        <p className="mt-2 text-xs text-gray-600">
          {t('Doctors: {added} new, {matched} already in your directory.', { added: notice.doctors_added.length, matched: notice.doctors_matched })}
          {notice.doctors_added.length > 0 && <span className="text-gray-500"> {notice.doctors_added.slice(0, 6).join(', ')}{notice.doctors_added.length > 6 ? '…' : ''}</span>}
        </p>
      )}
      {(notice.matches_open ?? 0) > 0 && <MatchQuestions uploadId={notice.upload_id} />}
      {notice.tests_new.length > 0 && <p className="mt-1 text-xs text-gray-600">{t('New tests, in no other document:')} {notice.tests_new.slice(0, 8).join(', ')}{notice.tests_new.length > 8 ? '…' : ''}</p>}
      {notice.looks_mixed && <CheckPages uploadId={notice.upload_id} />}
      {notice.grouping_pending && <p className="mt-2 text-xs text-gray-600">{t('The grouping is waiting for you to confirm it. Until then these documents are out of the timeline and search.')} <Link to={`/uploads/${notice.upload_id}`} className="text-blue-600 hover:underline">{t('Check the grouping')}</Link></p>}
      {notice.unread_pages > 0 && <p className="mt-1 text-xs text-amber-700">{tn(notice.unread_pages, '{n} page has no text that could be read.', '{n} pages have no text that could be read.')}</p>}
      {notice.undated_documents > 0 && <p className="mt-1 text-xs text-amber-700">{tn(notice.undated_documents, '{n} document has no date.', '{n} documents have no date.')}</p>}
      <p className="mt-3 text-xs text-gray-500">{t('Ask me anything about it, or tell me what to fix.')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} className={chip} onClick={() => onAsk(t('Summarize what was read from this upload and point out anything that looks wrong.'))}>{t('What was read from it?')}</button>
        {notice.grouping_pending && <button type="button" disabled={busy} className={chip} onClick={() => onAsk(t('The grouping is right. Please confirm it.'))}>{t('The grouping looks right')}</button>}
        {notice.unread_pages > 0 && <button type="button" disabled={busy} className={chip} onClick={() => onAsk(t('Some pages have no text. Read them again with AI.'))}>{t('Read the empty pages again')}</button>}
      </div>
    </div>
  );
}

/** What the app said when the analysis of a mixed upload finished: how many groups it found, and the questions that follow. */
export function RegroupNoticeMessage({ notice, busy, onAsk }: { notice: RegroupNotice; busy: boolean; onAsk: (question: string) => void }) {
  const { t, tn } = useI18n();
  const name = notice.file_name ?? t('The upload');
  const chip = 'rounded-full border border-gray-200 px-3 py-1.5 text-left text-xs text-gray-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50';
  if (notice.groups_changed === 0) {
    return <p className="text-sm text-gray-900">{t('I looked at the pages of “{name}”: they already sit with the pages they belong to, so nothing needs to change.', { name })}</p>;
  }
  return (
    <div className="text-sm text-gray-900">
      <p>{t('I looked at the pages of “{name}”: {groups} would change the grouping, {sure} of them confirmed by the model.', { name, groups: tn(notice.groups_changed, '{n} group', '{n} groups'), sure: notice.groups_validated })}</p>
      <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
        {notice.groups.map((g, i) => <li key={i} className="truncate">· {t('pages {pages}', { pages: g.page_numbers.join(', ') })}{g.title ? ` · ${g.title}` : ''}{g.status !== 'validated' ? ` · ${g.status === 'uncertain' ? t('uncertain') : t('not checked')}` : ''}</li>)}
      </ul>
      <p className="mt-3 text-xs text-gray-500">{t('Nothing has been changed. Ask me to show you, and you can look at each group before it is made.')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} className={chip} onClick={() => onAsk(t('Show me what you found and propose regrouping the pages the model was sure of.'))}>{t('Show me the suggested groups')}</button>
      </div>
    </div>
  );
}

/**
 * The pages' own text suggests some belong with pages of other documents. One press asks for the analysis (the press is the
 * confirmation, so what it does is said beside it): the pages are compared here, the model checks each group, and the result is
 * reported in this conversation. Nothing is changed by it.
 */
function CheckPages({ uploadId }: { uploadId: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'starting' | 'started' | 'failed'>('idle');
  const start = async () => {
    setState('starting');
    try { await api.chat.run({ method: 'POST', path: `/api/source-files/${uploadId}/regroup/analyze` }); setState('started'); } catch { setState('failed'); }
  };
  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 text-xs text-gray-700">
      <p>{t('By their text, some pages look as if they belong with pages of other documents.')}</p>
      {state === 'started' ? <p className="mt-1.5 text-gray-600" role="status">{t('Checking. I will tell you here when the suggestions are ready; nothing is changed until you confirm.')}</p> : (
        <>
          <button type="button" disabled={state === 'starting'} onClick={() => void start()} className="mt-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50">{state === 'starting' ? t('Starting…') : t('Check the pages with AI')}</button>
          <p className="mt-1.5 text-gray-500">{t('The pages are compared on this server, then the AI model checks each group. The text of the pages goes to the model provider, as it did when they were read.')}</p>
          {state === 'failed' && <p className="mt-1 text-red-600" role="alert">{t('Could not start the check.')}</p>}
        </>
      )}
    </div>
  );
}

const REASONS: Record<string, string> = {
  initial: msg('The same surname and an initial.'),
  fuller_name: msg('One name is a longer form of the other.'),
  punctuation: msg('They differ only in punctuation.'),
  legal_suffix: msg('They differ only in a company suffix (SRL, SA…).'),
  contained: msg('One name is inside the other; it may be the same place or a branch.'),
  spelling: msg('They are spelled almost the same.'),
  prefix: msg('One begins with the other.'),
};

type Answer = 'merged' | 'different' | 'kept' | 'changed' | 'failed';

/**
 * What this upload brought that may be the same as something already held, asked one by one: "is this the same doctor, test, tag,
 * clinic?" with the reason and what helps decide. Yes is the merge itself, through the ordinary route, into the entry that stays; No is
 * remembered so the question does not come back. A professional code that differs from the directory's is asked about too, since the
 * directory keeps one code per doctor and a name match leaves it as it is. Nothing is merged unless the person says yes.
 */
function MatchQuestions({ uploadId }: { uploadId: string }) {
  const { t, tn } = useI18n();
  const [questions, setQuestions] = useState<MatchQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer | 'working'>>({});

  useEffect(() => { api.matches.forUpload(uploadId).then(r => setQuestions(r.questions)).catch(() => setQuestions([])); }, [uploadId]);
  if (!questions || questions.length === 0) return null;

  const set = (id: string, answer: Answer | 'working') => setAnswers(prev => ({ ...prev, [id]: answer }));
  const merge = async (q: MatchQuestion) => {
    set(q.id, 'working');
    try {
      const keep = q.keep === 'new' ? q.new : q.existing!;
      const gone = q.keep === 'new' ? q.existing! : q.new;
      if (q.kind === 'doctor') await api.chat.run({ method: 'POST', path: `/api/doctors/${keep.doctor_id}/merge`, body: { from: gone.doctor_id } });
      else if (q.kind === 'tag') await api.chat.run({ method: 'POST', path: `/api/tags/${gone.tag_id}/merge`, body: { into: keep.tag_id } });
      else if (q.kind === 'test') await api.chat.run({ method: 'POST', path: '/api/measurements/merge', body: { from: gone.canonical, into: keep.canonical } });
      else await api.chat.run({ method: 'POST', path: '/api/providers/rename', body: { from: gone.name, to: keep.name } });
      set(q.id, 'merged');
      announceChange();
    } catch { set(q.id, 'failed'); }
  };
  const decide = async (q: MatchQuestion, answer: Answer, decision: 'different' | 'keep') => {
    set(q.id, 'working');
    try { await api.matches.decide(q.id, decision); set(q.id, answer); } catch { set(q.id, 'failed'); }
  };
  const useCode = async (q: MatchQuestion) => {
    set(q.id, 'working');
    try { await api.chat.run({ method: 'PATCH', path: `/api/doctors/${q.new.doctor_id}`, body: { license_code: q.codes!.printed } }); set(q.id, 'changed'); announceChange(); } catch { set(q.id, 'failed'); }
  };

  const label = (kind: MatchQuestion['kind']) => kind === 'doctor' ? t('doctor') : kind === 'test' ? t('test') : kind === 'tag' ? t('tag') : t('clinic or laboratory');
  const btn = 'rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50';
  const yes = 'rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50';

  return (
    <section className="mt-3 rounded-lg border border-blue-100 bg-blue-50/40 p-2.5" aria-label={t('Please check these')}>
      <p className="mb-2 text-xs font-medium text-gray-900">{tn(questions.length, 'Please check this match', 'Please check these {n} matches')}</p>
      <ul className="space-y-2.5">
        {questions.map(q => {
          const answer = answers[q.id];
          const busy = answer === 'working';
          return (
            <li key={q.id} className="rounded-lg bg-white p-2.5 text-xs text-gray-800">
              {q.kind === 'code' ? (
                <>
                  <p>{t('“{name}”: this document prints the professional code {printed}, but your directory has {directory}. Is it the same doctor?', { name: q.new.name, printed: q.codes!.printed, directory: q.codes!.directory })}</p>
                  {!answer || answer === 'working' || answer === 'failed' ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <button type="button" disabled={busy} className={yes} onClick={() => void useCode(q)}>{t('Same doctor: use {code}', { code: q.codes!.printed })}</button>
                      <button type="button" disabled={busy} className={btn} onClick={() => void decide(q, 'kept', 'keep')}>{t('Same doctor: keep {code}', { code: q.codes!.directory })}</button>
                      <Link to={`/doctors/${q.new.doctor_id}`} className={btn}>{t('Different people')}</Link>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <p>{t('Is “{a}” the same {what} as “{b}”?', { a: q.new.name, what: label(q.kind), b: q.existing!.name })}</p>
                  <p className="mt-0.5 text-gray-500">{t(REASONS[q.reason] ?? msg('They look alike.'))}{[q.new.detail, q.existing!.detail].some(Boolean) ? ` · ${[q.new.detail, q.existing!.detail].filter(Boolean).join(' / ')}` : ''}</p>
                  {q.kind === 'test' && (q.new.units?.length || q.existing!.units?.length) ? <p className="mt-0.5 text-gray-500">{t('Units')}: {(q.new.units ?? []).join(', ') || '—'} / {(q.existing!.units ?? []).join(', ') || '—'}</p> : null}
                  {q.unit_mismatch && <p className="mt-0.5 text-amber-700">{t('Different units: merging them would mix the values on one chart.')}</p>}
                  {!answer || answer === 'working' || answer === 'failed' ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <button type="button" disabled={busy} className={yes} onClick={() => void merge(q)}>{t('Yes, merge into “{name}”', { name: (q.keep === 'new' ? q.new : q.existing!).name })}</button>
                      <button type="button" disabled={busy} className={btn} onClick={() => void decide(q, 'different', 'different')}>{t('No, they are different')}</button>
                    </div>
                  ) : null}
                </>
              )}
              {answer === 'failed' && <p className="mt-1 text-red-600" role="alert">{t('Could not save that. Try again.')}</p>}
              {answer === 'merged' && <p className="mt-1 font-medium text-green-700" role="status">{t('Merged')}</p>}
              {answer === 'changed' && <p className="mt-1 font-medium text-green-700" role="status">{t('The directory now has that code')}</p>}
              {(answer === 'different' || answer === 'kept') && <p className="mt-1 text-gray-500" role="status">{answer === 'different' ? t('Kept separate; I will not ask again.') : t('Kept as it was; I will not ask again.')}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
