import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, ApiError, type AttachmentData, type ChatSource, type ChatStep, type ConversationSummary, type Proposal, type RegroupNotice, type UploadNotice } from '../api';
import { useOnDataChanged } from '../dataChanged';
import { msg } from '../i18n';

/**
 * The chat is one conversation for the whole app: it lives here, above the pages, so it follows the person from page to page
 * and is gone when the tab is closed (the server keeps nothing). Each question carries a description of what the person is
 * looking at, as *pointers* (which page, which document, which ids are listed, what is typed or selected), never text: the
 * server looks those up itself. A page adds detail with `useScreen`; the address supplies the rest.
 */
export interface ScreenInfo {
  page?: string;
  documentId?: string;
  uploadId?: string;
  doctorId?: string;
  documentIds?: string[];
  query?: string;
  filters?: Record<string, string>;
  test?: string;
  selectedId?: string;
  editing?: boolean;
  /** The page of the file that is open on a document page. */
  pageNumber?: number;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
  /** A message the app wrote (an upload finished), drawn from its data. */
  notice?: UploadNotice;
  regroupNotice?: RegroupNotice;
  /** Files the person attached: what became of each. */
  attachment?: AttachmentData;
  /** Changes the assistant prepared, waiting for the person. Not kept with the conversation: gone when it is reopened. */
  proposals?: Proposal[];
  /** A reply with nothing to say: nothing matched, it was switched off, or it failed. */
  note?: 'none' | 'failed' | 'off' | 'full' | 'stopped';
}

/** An answer on its way: what the agent has looked at so far, and the text written so far. */
export interface Draft { steps: ChatStep[]; text: string }

/** What the address alone says about the page. */
export function screenFromPath(pathname: string): ScreenInfo {
  const part = pathname.split('/').filter(Boolean);
  switch (part[0]) {
    case undefined: return { page: 'timeline' };
    case 'upload': return { page: 'upload' };
    case 'uploads': return { page: 'upload_pages', uploadId: part[1] };
    case 'review': return { page: 'review' };
    case 'documents': return { page: 'document', documentId: part[1] };
    case 'search': return { page: 'search' };
    case 'trends': return { page: 'trends' };
    case 'doctors': return part[1] ? { page: 'doctor', doctorId: part[1] } : { page: 'doctors' };
    case 'library': return { page: 'library' };
    case 'share': return { page: 'share' };
    case 'account': return { page: 'account' };
    default: return { page: 'other' };
  }
}

/** Titles of the conversations the app starts, so their translations are found (the title is stored in English). */
export const NOTICE_TITLES = [msg('Upload finished'), msg('Documents read'), msg('Upload failed'), msg('Regrouping suggestions'), msg('Nothing to regroup')];

/** Names of pages for the panel's "Looking at" line. */
export const PAGE_NAMES: Record<string, string> = {
  timeline: msg('Timeline'), upload: msg('Upload'), upload_pages: msg('Pages and grouping'), review: msg('Review'),
  document: msg('A document'), search: msg('Search'), trends: msg('Trends'), doctors: msg('Doctors'), doctor: msg('Doctors'),
  library: msg('Library'), share: msg('Share links'), account: msg('Account'), other: msg('Spine'),
};

interface ChatApi {
  /** Null until the server has said; false hides the chat. */
  enabled: boolean | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The conversation on show, and the person's conversations (null until loaded). */
  turns: Turn[];
  title: string | null;
  currentId: string | null;
  conversations: ConversationSummary[] | null;
  busy: boolean;
  /** The answer being written, while `busy`. */
  draft: Draft | null;
  send: (question: string, screenExtra?: ScreenInfo) => Promise<void>;
  /** Attach files (pasted, dropped or chosen), with a question if there is one. They are uploaded as usual and the conversation hears what becomes of them. */
  attach: (files: File[], question?: string) => Promise<void>;
  /** Read the conversation on show again from the server: the app added something to it. */
  reload: () => Promise<void>;
  /** Set when attaching failed, in words. */
  attachError: string;
  /** Give up on the question being answered; nothing of it is kept. */
  stop: () => void;
  /** Start a fresh conversation; the one on show stays in the history. */
  startNew: () => void;
  openConversation: (id: string) => Promise<void>;
  loadConversations: () => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  removeAll: () => Promise<void>;
  /** Conversations the app started that have not been opened (an upload finished). */
  unread: number;
  /** What the current page is, for display. */
  page: string;
  register: (info: ScreenInfo | null) => void;
}

const ChatContext = createContext<ChatApi | null>(null);
export const useChat = (): ChatApi | null => useContext(ChatContext);

/** The conversation open when the page was left, kept in this browser so a reload picks it up again. */
const REMEMBER = 'spine.chat.current';
const remembered = (): string | null => { try { return localStorage.getItem(REMEMBER); } catch { return null; } };
const remember = (id: string | null) => { try { if (id) localStorage.setItem(REMEMBER, id); else localStorage.removeItem(REMEMBER); } catch { /* it works without */ } };

const toTurn = (m: { role: 'user' | 'assistant'; content: string; sources: ChatSource[]; note: 'none' | 'failed' | 'off' | null; kind?: 'upload' | 'regroup' | 'attachment' | null; data?: UploadNotice | RegroupNotice | AttachmentData | null }): Turn =>
  ({ role: m.role, content: m.content, sources: m.sources, ...(m.note ? { note: m.note } : {}), ...(m.kind === 'upload' && m.data ? { notice: m.data as UploadNotice } : {}), ...(m.kind === 'regroup' && m.data ? { regroupNotice: m.data as RegroupNotice } : {}), ...(m.kind === 'attachment' && m.data ? { attachment: m.data as AttachmentData } : {}) });

export function ChatProvider({ authenticated, children }: { authenticated: boolean; children: React.ReactNode }) {
  const location = useLocation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [unread, setUnread] = useState(0);
  const asking = useRef<AbortController | null>(null);
  const registered = useRef<ScreenInfo | null>(null);
  const path = useRef(location.pathname);
  path.current = location.pathname;

  // A question in flight is let go without a word when the conversation it belongs to is left.
  const drop = useCallback(() => { const going = asking.current; asking.current = null; going?.abort(); }, []);

  const loadConversations = useCallback(async () => {
    try { setConversations(await api.chat.conversations()); } catch { setConversations([]); }
  }, []);

  const openConversation = useCallback(async (id: string) => {
    drop();
    try {
      const c = await api.chat.conversation(id);
      setTurns(c.messages.map(toTurn)); setTitle(c.title); setCurrentId(c.id); remember(c.id);
      // Opening a conversation the app started is reading it.
      if (c.unread) { void api.chat.markRead(c.id).catch(() => undefined); setUnread(n => Math.max(0, n - 1)); }
    } catch {
      // Gone (deleted elsewhere): nothing to show, and not to try again.
      remember(null); setTurns([]); setTitle(null); setCurrentId(null);
    }
  }, [drop]);

  useEffect(() => {
    if (!authenticated) { drop(); setEnabled(null); setTurns([]); setTitle(null); setCurrentId(null); setConversations(null); setOpen(false); return; }
    api.chat.status().then(s => {
      setEnabled(s.enabled);
      const id = remembered();
      if (s.enabled && id) void openConversation(id);
    }).catch(() => setEnabled(false));
  }, [authenticated, openConversation, drop]);

  // Conversations the app starts (an upload finished) are looked for now, when the page comes back to the front, and every half
  // minute: cheap, and the owner is usually somewhere else when one is written. A change made here (a confirm) looks again at once.
  const refreshUnread = useCallback(() => { void api.chat.unread().then(r => setUnread(r.count)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!authenticated || !enabled) { setUnread(0); return; }
    refreshUnread();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refreshUnread(); }, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refreshUnread(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [authenticated, enabled, refreshUnread]);
  useOnDataChanged(refreshUnread);
  // A new conversation shows in the history as soon as the badge says there is one.
  useEffect(() => { if (unread > 0) void loadConversations(); }, [unread, loadConversations]);

  const register = useCallback((info: ScreenInfo | null) => { registered.current = info; }, []);

  const send = useCallback(async (text: string, screenExtra?: ScreenInfo) => {
    const question = text.trim();
    if (!question) return;
    // The address says which page; a page that registered adds what only it knows.
    const screen = { ...screenFromPath(path.current), ...(registered.current ?? {}), ...(screenExtra ?? {}) };
    setTurns(prev => [...prev, { role: 'user', content: question }]);
    setBusy(true);
    setDraft({ steps: [], text: '' });
    const controller = new AbortController();
    asking.current = controller;
    try {
      const reply = await api.chat.ask(question, currentId, screen, {
        step: step => setDraft(d => d && { ...d, steps: [...d.steps, step] }),
        delta: text => setDraft(d => d && { ...d, text: d.text + text }),
        reset: () => setDraft(d => d && { ...d, text: '' }),
      }, controller.signal);
      setCurrentId(reply.conversation.id); setTitle(reply.conversation.title); remember(reply.conversation.id);
      setTurns(prev => [...prev, reply.answer === null
        ? { role: 'assistant', content: '', note: 'none' }
        : { role: 'assistant', content: reply.answer, sources: reply.sources, proposals: reply.proposals }]);
      void loadConversations();
    } catch (err) {
      // Dropped because the conversation was left (see `drop`): there is nothing to say in this one any more.
      if (controller.signal.aborted && asking.current !== controller) return;
      const message = err instanceof ApiError ? err.message : '';
      setTurns(prev => [...prev, {
        role: 'assistant', content: '',
        note: controller.signal.aborted ? 'stopped' : err instanceof ApiError && err.status === 409 ? (/full/.test(message) ? 'full' : 'off') : 'failed',
      }]);
    } finally {
      // Unless a later question has taken over (this one was dropped), the page is free again.
      if (asking.current === controller || asking.current === null) { asking.current = null; setBusy(false); setDraft(null); }
    }
  }, [currentId, loadConversations]);

  const [attachError, setAttachError] = useState('');
  const attach = useCallback(async (files: File[], text?: string) => {
    if (files.length === 0) return;
    setAttachError('');
    setBusy(true);
    try {
      const made = await api.chat.attach(files, currentId);
      setCurrentId(made.conversation.id); setTitle(made.conversation.title); remember(made.conversation.id);
      setTurns(prev => [...prev, { role: 'user', content: '', attachment: { files: made.files } }]);
      void loadConversations();
      setBusy(false);
      // A question that came with them is asked about the upload that was just started.
      const reading = made.files.find(f => f.upload_id && f.state === 'reading');
      if (text?.trim()) await send(text, reading ? { uploadId: reading.upload_id! } : undefined);
    } catch (err) {
      setAttachError(err instanceof ApiError ? err.message : msg('The files could not be attached.'));
    } finally {
      setBusy(false);
    }
  // `send` reads the current conversation itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, loadConversations, send]);
  const reload = useCallback(async () => { if (currentId) await openConversation(currentId); }, [currentId, openConversation]);

  const stop = useCallback(() => asking.current?.abort(), []);

  const startNew = useCallback(() => { drop(); setTurns([]); setTitle(null); setCurrentId(null); remember(null); }, [drop]);

  const removeConversation = useCallback(async (id: string) => {
    try { await api.chat.deleteConversation(id); } catch { /* listed again below */ }
    if (id === currentId) startNew();
    await loadConversations();
  }, [currentId, startNew, loadConversations]);

  const removeAll = useCallback(async () => {
    try { await api.chat.deleteAllConversations(); } catch { /* listed again below */ }
    startNew();
    await loadConversations();
  }, [startNew, loadConversations]);

  const value = useMemo<ChatApi>(() => ({
    enabled, open, setOpen, turns, title, currentId, conversations, busy, draft, send, attach, reload, attachError, stop, startNew, openConversation, loadConversations,
    removeConversation, removeAll, unread, page: screenFromPath(location.pathname).page ?? 'other', register,
  }), [enabled, open, turns, title, currentId, conversations, busy, draft, unread, send, attach, reload, attachError, stop, startNew, openConversation, loadConversations, removeConversation, removeAll, location.pathname, register]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/** A page tells the chat what it is showing beyond what the address says. Cleared when the page goes. */
export function useScreen(info: ScreenInfo | null) {
  const chat = useChat();
  const register = chat?.register;
  const key = JSON.stringify(info);
  useEffect(() => {
    register?.(info);
    return () => register?.(null);
    // `key` is the content of `info`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, register]);
}
