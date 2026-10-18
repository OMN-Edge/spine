import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ChatSource, type ChatStep } from '../api';
import { useI18n } from '../i18n';
import { documentTitle } from '../titles';
import Markdown from './Markdown';
import { draftText, stepText } from './chatSteps';

interface Turn { role: 'user' | 'assistant'; content: string; sources?: ChatSource[]; note?: 'none' | 'failed' | 'stopped' }

/** An answer's citations name documents for the request that wrote them; in a later turn they would point at nothing. */
const withoutCitations = (text: string) => text.replace(/\s*\[[DTCS]\d+(?:\.[a-z]+)?\]/g, '');

/**
 * Questions from the recipient of a share link, about the documents it shares. Smaller than the owner's chat on purpose: the
 * conversation lives in this page and nowhere else (nothing is stored, a reload starts again), there is no history, and a
 * citation links to the shared document in this same page.
 */
export default function SharedChat({ token, openId }: { token: string; openId: string | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // The answer on its way: what the assistant has looked at, and the text written so far (a draft: citations come with the final reply).
  const [draft, setDraft] = useState<{ steps: ChatStep[]; text: string } | null>(null);
  const asking = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) end.current?.scrollIntoView({ block: 'end' }); }, [open, turns, busy]);

  const send = async () => {
    const question = text.trim();
    if (!question || busy) return;
    setText('');
    setBusy(true);
    const history = turns.filter(x => !x.note).map(x => ({ role: x.role, content: x.role === 'assistant' ? withoutCitations(x.content) : x.content })).slice(-6);
    setTurns(prev => [...prev, { role: 'user', content: question }]);
    setDraft({ steps: [], text: '' });
    const controller = new AbortController();
    asking.current = controller;
    try {
      const reply = await api.publicShare.chat(token, { question, history, document_id: openId ?? undefined }, {
        step: step => setDraft(d => d && { ...d, steps: [...d.steps, step] }),
        delta: text => setDraft(d => d && { ...d, text: d.text + text }),
        reset: () => setDraft(d => d && { ...d, text: '' }),
      }, controller.signal);
      setTurns(prev => [...prev, reply.answer === null
        ? { role: 'assistant', content: '', note: 'none' }
        : { role: 'assistant', content: reply.answer, sources: reply.sources }]);
    } catch {
      if (controller.signal.aborted) {
        setTurns(prev => [...prev, { role: 'assistant', content: '', note: 'stopped' }]);
      } else {
        setTurns(prev => [...prev, { role: 'assistant', content: '', note: 'failed' }]);
      }
    } finally {
      asking.current = null;
      setBusy(false);
      setDraft(null);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} aria-label={t('Ask about these documents')}
        className="fixed bottom-5 right-5 z-30 rounded-full border border-gray-200 bg-white py-2.5 px-4 text-sm text-gray-700 shadow-md hover:shadow-lg">
        {t('Ask')}
      </button>
    );
  }

  return (
    <aside role="complementary" aria-label={t('Ask about these documents')}
      className="fixed inset-0 z-40 flex flex-col bg-white sm:inset-auto sm:bottom-3 sm:right-3 sm:top-3 sm:w-[25rem] sm:rounded-2xl sm:border sm:border-gray-200 sm:shadow-xl">
      <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3.5">
        <div className="min-w-0">
          <h2 className="text-[0.95rem] font-medium text-gray-900">{t('Ask about these documents')}</h2>
          <p className="mt-0.5 text-xs text-gray-400">{t('Only the documents in this share')}</p>
        </div>
        <div className="flex shrink-0 gap-3 text-xs">
          {turns.length > 0 && <button type="button" onClick={() => setTurns([])} className="text-gray-500 hover:text-gray-800">{t('Clear')}</button>}
          <button type="button" onClick={() => setOpen(false)} aria-label={t('Close')} className="text-gray-500 hover:text-gray-800">{t('Close')}</button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {turns.length === 0 && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-gray-400">{t('Answers come only from the documents in this share, with links to where they came from. They are a reading of what the documents say, not medical advice.')}</p>
            <p className="text-xs leading-relaxed text-gray-400">{t('Each question sends your words and parts of the shared documents to an AI model. Nothing you ask is kept: closing or reloading this page clears it.')}</p>
          </div>
        )}
        {turns.map((turn, i) => turn.role === 'user' ? (
          <div key={i} className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-blue-50 px-3.5 py-2 text-sm text-gray-900">{turn.content}</p>
          </div>
        ) : turn.note ? (
          <p key={i} className={`text-sm ${turn.note === 'none' ? 'text-gray-500' : 'text-red-600'}`}>
            {turn.note === 'none' ? t('Nothing in this share matches this. Try other words.') : turn.note === 'stopped' ? t('Stopped.') : t('Could not answer just now. Try again.')}
          </p>
        ) : (
          <div key={i} className="text-sm text-gray-900">
            <Markdown text={turn.content} cite={label => {
              const source = (turn.sources ?? []).find(s => s.label === label) ?? (turn.sources ?? []).find(s => s.label.split('.')[0] === label.split('.')[0]);
              if (!source) return null;
              const n = (turn.sources ?? []).indexOf(source) + 1;
              return <Link to={`?d=${source.id}`} title={documentTitle(source, t)} onClick={() => { if (window.matchMedia('(max-width: 767px)').matches) setOpen(false); }}
                className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-blue-50 px-1 align-text-top text-[10px] font-semibold text-blue-700 hover:bg-blue-100">{n}</Link>;
            }} />
          </div>
        ))}
        {busy && (
          <div className="text-sm" role="status" aria-live="polite">
            {draft && draft.steps.length > 0 && (
              <ul className="mb-2 space-y-0.5 text-xs text-gray-400">
                {draft.steps.slice(-3).map((step, n) => <li key={draft.steps.length - 3 + n} className="truncate">{stepText(t, step)}</li>)}
              </ul>
            )}
            {draft?.text
              ? <div className="text-gray-900"><Markdown text={draftText(draft.text)} cite={() => null} /></div>
              : <p className="text-gray-400">{draft?.steps.length ? '' : t('Reading the documents…')}</p>}
          </div>
        )}
        <div ref={end} />
      </div>

      <form onSubmit={e => { e.preventDefault(); void send(); }} className="px-3 pb-3 pt-1">
        <div className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-gray-50/60 py-1.5 pl-3.5 pr-1.5">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={1} maxLength={1000} aria-label={t('Your question')} placeholder={t('Ask about these documents…')}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            className="max-h-32 min-h-[2rem] flex-1 resize-none bg-transparent py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none" />
          {busy
            ? <button type="button" onClick={() => asking.current?.abort()} aria-label={t('Stop')} className="h-8 shrink-0 rounded-full bg-gray-800 px-3 text-sm text-white">{t('Stop')}</button>
            : <button type="submit" disabled={!text.trim()} aria-label={t('Ask')} className="h-8 shrink-0 rounded-full bg-blue-600 px-3 text-sm text-white disabled:opacity-50">{t('Ask')}</button>}
        </div>
      </form>
    </aside>
  );
}
