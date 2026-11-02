import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, type GuideKey, type GuideState } from './api';
import { useOnDataChanged } from './dataChanged';

/**
 * What helps a person start, and what has already been shown (core's `routes/guide.ts`): the chat's welcome, a tip the first time something
 * happens, the Get started checklist. Kept with the records, so a second device does not greet them again. Off in the demo, which keeps
 * nothing, and until the records are open.
 *
 * The welcome is not pushy: the chat never opens on it by itself, over the page. The first times the app is opened a small note beside Ask
 * offers it; after the one shown with nothing before and `WELCOME_NOTES` more it stops. Anything done from it (a button, a question) puts it away, and so does a first upload.
 */
export const WELCOME_NOTES = 3;

/** What the welcome does this time the app is opened, decided once from what was shown before. */
export type WelcomeMode = 'note' | 'none';

/** A note while it has been shown no more than `WELCOME_NOTES` times before, nothing was done from it and nothing was uploaded; never the chat opened over the page. */
export function welcomeMode({ shown, done, uploads }: { shown: number; done: boolean; uploads: number }): WelcomeMode {
  return done || uploads > 0 || shown > WELCOME_NOTES ? 'none' : 'note';
}

interface GuideApi {
  state: GuideState | null;
  welcome: WelcomeMode;
  /** Whether it was done with (or, for the welcome, is past). */
  isDone: (key: GuideKey) => boolean;
  /** Counts a showing, at most once each time the app is opened. */
  shown: (key: GuideKey) => void;
  done: (key: GuideKey) => void;
  refresh: () => void;
}

const GuideContext = createContext<GuideApi | null>(null);
export const useGuide = (): GuideApi | null => useContext(GuideContext);

export function GuideProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [state, setState] = useState<GuideState | null>(null);
  const [welcome, setWelcome] = useState<WelcomeMode>('none');
  const counted = useRef(new Set<GuideKey>());
  const decided = useRef(false);

  const refresh = useCallback(() => { if (enabled) void api.guide.state().then(setState).catch(() => undefined); }, [enabled]);
  useEffect(() => {
    counted.current.clear(); decided.current = false; setWelcome('none'); setState(null);
    refresh();
  }, [enabled, refresh]);
  useOnDataChanged(refresh);
  // How far the person has got changes on other pages (an upload, a confirmed grouping, a link), so it is read again on the way to the next.
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } refresh(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useCallback((key: GuideKey) => {
    if (!enabled || counted.current.has(key)) return;
    counted.current.add(key);
    void api.guide.shown(key).catch(() => undefined);
  }, [enabled]);

  const done = useCallback((key: GuideKey) => {
    if (!enabled) return;
    setState(s => s && { ...s, marks: { ...s.marks, [key]: { shown: s.marks[key]?.shown ?? 0, last_shown_at: s.marks[key]?.last_shown_at ?? null, done_at: s.marks[key]?.done_at ?? new Date().toISOString() } } });
    if (key === 'welcome') setWelcome('none');
    void api.guide.done(key).catch(() => undefined);
  }, [enabled]);

  // Once a session: the first few times a note beside Ask offers the welcome; then nothing. The chat never opens by itself over the page.
  useEffect(() => {
    if (!state || decided.current) return;
    decided.current = true;
    const mark = state.marks.welcome;
    const mode = welcomeMode({ shown: mark?.shown ?? 0, done: !!mark?.done_at, uploads: state.progress.uploads });
    setWelcome(mode);
    if (mode !== 'none') shown('welcome');
  }, [state, shown]);

  const isDone = useCallback((key: GuideKey) => !!state?.marks[key]?.done_at, [state]);

  const value = useMemo<GuideApi>(() => ({ state, welcome, isDone, shown, done, refresh }), [state, welcome, isDone, shown, done, refresh]);
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}
