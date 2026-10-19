import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { type ChatSource, type ChatStep } from '../api';
import { useI18n } from '../i18n';
import { PAGE_NAMES, useChat } from './ChatProvider';
import Markdown from './Markdown';
import ProposalCard from './ProposalCard';
import { draftText, stepText } from './chatSteps';
import UploadNoticeMessage, { RegroupNoticeMessage } from './UploadNoticeMessage';
import AttachmentMessage from './AttachmentMessage';
import AnswerSources, { chipClass, numbered, sourceFor, useSourceName } from './AnswerSources';

const hrefOf = (s: ChatSource) => `/documents/${s.id}${s.section ? `?section=${s.section}` : ''}`;

/** Questions worth asking from where the person is. */
function suggestionsFor(page: string, t: (s: string) => string): string[] {
  if (page === 'document') return [t('Explain this document in plain words'), t('Is anything outside the reference range?')];
  return [t('What was my last hemoglobin, and how did it change?'), t('Which tests did the cardiologist ask for, and where are the results?'), t('Prepare a link to share my latest cardiology visit and its tests')];
}

/**
 * The chat, on every page: a button in the corner that opens a panel beside the page. It knows what page the person is on
 * and what they have open, so "what does this mean?" has something to mean, and an answer can point at a part of the
 * document they are looking at.
 */
export default function ChatPanel() {
  const { t, tn } = useI18n();
  const nameOf = useSourceName();
  const chat = useChat();
  const [text, setText] = useState('');
  // Files waiting to be sent with the next message: pasted, dropped or chosen.
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // The conversation, or the list of them. Not remembered: the panel opens on the conversation.
  const [view, setView] = useState<'chat' | 'history'>('chat');
  // A delete asks again, in place: this is which one is waiting for the yes ('all' for every conversation).
  const [confirming, setConfirming] = useState<string | null>(null);
  // The panel eases in rather than appearing.
  const [entered, setEntered] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // The box grows with what is typed (up to a limit, then it scrolls) and shrinks back once the message is sent.
  useEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 192)}px`;
  }, [text, view, chat?.open]);

  const open = chat?.open ?? false;
  useEffect(() => {
    if (!open) { setEntered(false); return; }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => { if (open && view === 'chat') { end.current?.scrollIntoView({ block: 'end' }); } }, [open, view, chat?.turns, chat?.busy, chat?.draft]);
  useEffect(() => { if (open && view === 'chat') input.current?.focus(); }, [open, view]);
  useEffect(() => { if (open) setView('chat'); }, [open]);
  useEffect(() => { if (view === 'history') { setConfirming(null); void chat?.loadConversations(); } }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (view === 'history') setView('chat'); else chat?.setOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, view, chat]);

  if (!chat || !chat.enabled) return null;
  const { turns, busy, conversations, draft } = chat;
  const stepLine = (step: ChatStep) => stepText(t, step);
  // On a phone the panel covers the page, so following a citation closes it.
  const follow = () => { if (window.matchMedia('(max-width: 767px)').matches) chat.setOpen(false); };

  const send = async () => {
    const question = text.trim();
    if ((!question && files.length === 0) || busy) return;
    const attached = files;
    setText(''); setFiles([]);
    if (attached.length > 0) await chat.attach(attached, question);
    else await chat.send(question);
  };
  // Pasting a file (a screenshot or a document copied in Finder or Files), dropping one, or choosing one all add it to the message.
  const addFiles = (list: FileList | File[] | null | undefined) => {
    const added = Array.from(list ?? []).filter(f => f.size > 0);
    if (added.length > 0) setFiles(prev => [...prev, ...added].slice(0, 20));
  };

  if (!open) {
    // The app started a conversation (an upload finished): a note beside the button says so, and opens it.
    const waiting = conversations?.find(c => c.unread) ?? null;
    return (
      <>
      {chat.unread > 0 && waiting && (
        <button
          type="button" onClick={() => { chat.setOpen(true); void chat.openConversation(waiting.id); }}
          className="fixed bottom-16 right-5 z-30 max-w-[16rem] rounded-2xl rounded-br-md border border-blue-200 bg-white px-3.5 py-2 text-left text-sm text-gray-800 shadow-md transition hover:shadow-lg"
        >
          {t(waiting.title)} <span className="text-blue-600">· {t('take a look')}</span>
        </button>
      )}
      <button
        type="button" onClick={() => chat.setOpen(true)} aria-label={chat.unread > 0 ? t('Ask your records') + ` (${chat.unread})` : t('Ask your records')}
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full border border-gray-200 bg-white/95 py-2.5 pl-3.5 pr-4 text-sm text-gray-700 shadow-md backdrop-blur transition hover:shadow-lg hover:text-gray-900"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-blue-600" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15z" />
        </svg>
        {t('Ask')}
        {chat.unread > 0 && <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold text-white" aria-hidden="true">{chat.unread}</span>}
      </button>
      </>
    );
  }

  const iconButton = 'rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700';
  const icon = (d: string) => (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );

  return (
    <aside
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => { if (e.dataTransfer.files.length > 0) { e.preventDefault(); addFiles(e.dataTransfer.files); } setDragging(false); }}
      role="complementary" aria-label={t('Ask your records')}
      className={`fixed inset-0 z-40 flex flex-col bg-white transition duration-200 ease-out sm:inset-auto sm:bottom-3 sm:right-3 sm:top-[4.25rem] sm:w-[25rem] sm:rounded-2xl sm:border sm:border-gray-200 sm:shadow-[0_10px_40px_-12px_rgba(15,23,42,0.2)] ${entered ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
    >
      {dragging && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-400 bg-blue-50/80 text-sm font-medium text-blue-700">{t('Drop files to attach them')}</div>}
      <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3.5">
        <div className="min-w-0">
          <h2 className="truncate text-[0.95rem] font-medium text-gray-900">{view === 'history' ? t('Conversations') : (turns[0]?.notice || turns[0]?.regroupNotice ? t(chat.title ?? '') : (chat.title ?? t('Ask your records')))}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-gray-400">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
            {t('Looking at: {page}', { page: t(PAGE_NAMES[chat.page] ?? PAGE_NAMES.other) })}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <button type="button" onClick={() => setView(v => (v === 'history' ? 'chat' : 'history'))} aria-pressed={view === 'history'} title={t('History')} aria-label={t('History')} className={`${iconButton} ${view === 'history' ? 'bg-gray-100 text-gray-900' : ''}`}>
            {icon('M12 7v5l3 2M21 12a9 9 0 1 1-3-6.7M21 4v4h-4')}
          </button>
          <button type="button" onClick={() => { chat.startNew(); setView('chat'); }} title={t('New conversation')} aria-label={t('New conversation')} className={iconButton}>
            {icon('M12 5v14M5 12h14')}
          </button>
          <button type="button" onClick={() => chat.setOpen(false)} title={t('Close')} aria-label={t('Close')} className={iconButton}>
            {icon('M6 6l12 12M18 6L6 18')}
          </button>
        </div>
      </div>

      {view === 'history' ? (
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {conversations === null ? (
            <p className="px-2 py-3 text-sm text-gray-400">{t('Loading…')}</p>
          ) : conversations.length === 0 ? (
            <p className="px-2 py-3 text-sm text-gray-400">{t('No conversations yet.')}</p>
          ) : (
            <>
              <ul className="space-y-0.5">
                {conversations.map(c => (
                  <li key={c.id} className={`group flex items-center gap-1 rounded-lg ${c.id === chat.currentId ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <button type="button" onClick={async () => { await chat.openConversation(c.id); setView('chat'); }} className="min-w-0 flex-1 px-3 py-2 text-left">
                      <span className={`block truncate text-sm text-gray-900 ${c.unread ? 'font-semibold' : ''}`}>{c.unread && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-600 align-middle" aria-label={t('Unread')} />}{c.origin ? t(c.title) : c.title}</span>
                      <span className="block text-xs text-gray-400">{c.updated_at.slice(0, 10)} · {tn(c.message_count, '{n} message', '{n} messages')}</span>
                    </button>
                    {confirming === c.id ? (
                      <span className="flex shrink-0 items-center gap-2 pr-2 text-xs">
                        <button type="button" onClick={async () => { setConfirming(null); await chat.removeConversation(c.id); }} className="font-medium text-red-600 hover:underline">{t('Delete')}</button>
                        <button type="button" onClick={() => setConfirming(null)} className="text-gray-500 hover:underline">{t('Cancel')}</button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setConfirming(c.id)} title={t('Delete this conversation')} aria-label={t('Delete this conversation')} className={`${iconButton} mr-1 shrink-0 opacity-60 hover:opacity-100 group-hover:opacity-100`}>
                        {icon('M5 7h14M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="px-3 pb-2 pt-4 text-xs">
                {confirming === 'all' ? (
                  <span className="flex items-center gap-3">
                    <span className="text-gray-600">{t('Delete every conversation? This cannot be undone.')}</span>
                    <button type="button" onClick={async () => { setConfirming(null); await chat.removeAll(); }} className="font-medium text-red-600 hover:underline">{t('Delete')}</button>
                    <button type="button" onClick={() => setConfirming(null)} className="text-gray-500 hover:underline">{t('Cancel')}</button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirming('all')} className="text-gray-500 hover:text-red-600 hover:underline">{t('Delete all conversations')}</button>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {turns.length === 0 && !busy && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {suggestionsFor(chat.page, t).map(q => (
                  <button key={q} type="button" onClick={() => void chat.send(q)} className="rounded-full border border-gray-200 px-3 py-1.5 text-left text-xs text-gray-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700">{q}</button>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-gray-400">{t('Answers come only from your own documents, with links to where they came from. They are a reading of what the documents say, not medical advice: ask your doctor what they mean for you.')}</p>
              <p className="text-xs leading-relaxed text-gray-400">{t('Each question sends your words and the summaries and results of the matching documents to the AI model this server uses. Your conversations are kept in your archive, in History, until you delete them.')}</p>
            </div>
          )}
          {turns.map((turn, i) => turn.attachment ? (
            <AttachmentMessage key={i} files={turn.attachment.files} onSettled={() => void chat.reload()} />
          ) : turn.regroupNotice ? (
            <div key={i}><RegroupNoticeMessage notice={turn.regroupNotice} busy={busy} onAsk={q => void chat.send(q)} /></div>
          ) : turn.notice ? (
            <div key={i}><UploadNoticeMessage notice={turn.notice} busy={busy} onAsk={q => void chat.send(q)} /></div>
          ) : turn.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-blue-50 px-3.5 py-2 text-sm text-gray-900">{turn.content}</p>
            </div>
          ) : (
            <div key={i} className="text-sm">
              {turn.note ? (
                <p className={turn.note === 'none' || turn.note === 'stopped' ? 'text-gray-500' : 'text-red-600'}>
                  {turn.note === 'none' ? t('No document in your archive matches this. Try other words.')
                    : turn.note === 'stopped' ? t('Stopped.')
                    : turn.note === 'off' ? t('Asking questions is switched off on this server.')
                    : turn.note === 'full' ? t('This conversation is full. Start a new one.')
                    : t('Could not answer just now. Try again.')}
                </p>
              ) : (
                (() => {
                  const sources = numbered(turn.content, turn.sources ?? []);
                  const numberOf = (source: ChatSource) => sources.indexOf(source) + 1;
                  // A citation becomes its number, as a link to the document or to the part of it; one that cannot be tied to a source is dropped.
                  const cite = (label: string) => {
                    const source = sourceFor(label, turn.sources ?? []);
                    return source ? (
                      <Link
                        to={hrefOf(source)} onClick={follow} title={nameOf(source)}
                        className={`mx-0.5 align-text-top hover:bg-blue-100 ${chipClass}`}
                      >{numberOf(source)}</Link>
                    ) : null;
                  };
                  return (
                    <>
                      <div className="text-gray-900"><Markdown text={turn.content} cite={cite} /></div>
                      <AnswerSources sources={sources} hrefOf={hrefOf} onFollow={follow} owner />
                      {(turn.proposals ?? []).map(p => <ProposalCard key={p.id} proposal={p} />)}
                    </>
                  );
                })()
              )}
            </div>
          ))}
          {busy && draft && (
            <div className="text-sm" role="status" aria-live="polite">
              {draft.steps.length > 0 && (
                <ul className="mb-2 space-y-0.5 text-xs text-gray-400">
                  {draft.steps.slice(-3).map((step, n, shown) => (
                    <li key={draft.steps.length - shown.length + n} className={`truncate ${n === shown.length - 1 && !draft.text ? 'text-gray-500' : ''}`}>{stepLine(step)}</li>
                  ))}
                </ul>
              )}
              {draft.text ? (
                <div className="text-gray-900"><Markdown text={draftText(draft.text)} cite={() => null} /></div>
              ) : (
                <p className="flex items-center gap-2 text-gray-400">
                  <span className="flex gap-1" aria-hidden="true">
                    {[0, 1, 2].map(d => <span key={d} className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-300" style={{ animationDelay: `${d * 200}ms` }} />)}
                  </span>
                  {draft.steps.length === 0 && t('Reading your documents…')}
                </p>
              )}
            </div>
          )}
          <div ref={end} />
        </div>
      )}

      {view === 'chat' && (
        <form onSubmit={e => { e.preventDefault(); void send(); }} className="px-3 pb-3 pt-1">
          {chat.attachError && <p className="px-1 pb-1 text-xs text-red-600" role="alert">{t(chat.attachError)}</p>}
          {files.length > 0 && (
            <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label={t('Files to send')}>
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex max-w-full items-center gap-1 rounded-full border border-gray-200 bg-white py-0.5 pl-2.5 pr-1 text-xs text-gray-700">
                  <span className="truncate">{f.name}</span>
                  <button type="button" onClick={() => setFiles(prev => prev.filter((_, n) => n !== i))} aria-label={t('Remove this file')} title={t('Remove this file')} className="rounded-full px-1.5 text-gray-400 hover:text-red-600">×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-gray-50/60 py-1.5 pl-3.5 pr-1.5 transition focus-within:border-blue-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100">
            <input ref={picker} type="file" multiple accept=".pdf,.zip,application/pdf,application/zip,image/*" className="hidden" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            <button type="button" onClick={() => picker.current?.click()} disabled={busy} title={t('Attach a file')} aria-label={t('Attach a file')} className="-ml-1.5 mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50">
              <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.3-8.3" /></svg>
            </button>
            <textarea
              ref={input} value={text} onChange={e => setText(e.target.value)} rows={1} maxLength={1000}
              // A keyboard sends on Enter (Shift+Enter is a new line); a touch screen has no Shift, so there Enter is a new line and the arrow sends.
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) { e.preventDefault(); void send(); } }}
              onPaste={e => { if (e.clipboardData.files.length > 0) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
              aria-label={t('Your question')} placeholder={files.length > 0 ? t('Add a message, or just send…') : t('Ask about your records, or paste a file…')}
              className="max-h-48 min-h-[2rem] flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
            />
            {busy ? (
              <button type="button" onClick={chat.stop} title={t('Stop')} aria-label={t('Stop')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-800 text-white transition hover:bg-gray-700">
                <span className="h-2.5 w-2.5 rounded-sm bg-white" aria-hidden="true" />
              </button>
            ) : (
              <button type="submit" disabled={!text.trim() && files.length === 0} title={t('Ask')} aria-label={t('Ask')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            )}
          </div>
        </form>
      )}
    </aside>
  );
}
