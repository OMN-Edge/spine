import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useI18n } from './i18n';

/** The most titles one request asks for (the core's limit); a longer list is asked for in turns. */
const CHUNK = 60;

/**
 * The titles and summaries of the documents a list shows, in the interface language: what is kept comes at once, and a document not yet translated is
 * translated in the background and asked for again shortly. Only texts that still match their document are given, so one is never translated from
 * different words. A list that shows part of its documents at a time passes the ones on screen.
 * With `warm` false only what is kept is asked for and nothing is started, for a list of every document that is not itself what the reader came to see.
 * `titleOf` and `summaryOf` give what to show for a document: the translation where there is one, else the document's own.
 */
export function useListTitles(ids: string[], warm = true) {
  const { lang } = useI18n();
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const key = [...new Set(ids)].join(',');
  useEffect(() => { setTitles({}); setSummaries({}); }, [lang]);
  useEffect(() => {
    if (!key) return;
    let live = true;
    let timer: number | undefined;
    let tries = 0;
    const all = key.split(',');
    const load = async () => {
      let pending = false;
      for (let i = 0; i < all.length && live; i += CHUNK) {
        const answer = await api.documents.titles(all.slice(i, i + CHUNK), lang, warm).catch(() => null);
        if (!answer || !live) continue;
        pending ||= answer.pending;
        setTitles(held => ({ ...held, ...answer.titles }));
        setSummaries(held => ({ ...held, ...(answer.summaries ?? {}) }));
      }
      if (live && pending && tries++ < 8) timer = window.setTimeout(() => { void load(); }, 3000);
    };
    void load();
    return () => { live = false; window.clearTimeout(timer); };
  }, [key, lang, warm]);
  return {
    titleOf: <T extends { id: string; title: string | null }>(doc: T): string | null => titles[doc.id] ?? doc.title,
    summaryOf: <T extends { id: string; ai_summary: string | null }>(doc: T): string | null => summaries[doc.id] ?? doc.ai_summary,
  };
}

/**
 * Specialties and test names in the interface language, for the pages that list them across documents: as kept (one translation for each text, so
 * every doctor and every document with it says the same), and what is not kept yet is translated in the background and asked for again shortly.
 * Each gives the original back where there is nothing to show.
 */
export function useNames() {
  const { lang } = useI18n();
  const [names, setNames] = useState<{ specialties: Record<string, string>; tests: Record<string, string> }>({ specialties: {}, tests: {} });
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    let tries = 0;
    setNames({ specialties: {}, tests: {} });
    const load = () => api.documents.names(lang)
      .then(r => { if (!live) return; setNames({ specialties: r.specialties, tests: r.tests }); if (r.pending && tries++ < 8) timer = window.setTimeout(load, 3000); })
      .catch(() => undefined);
    void load();
    return () => { live = false; window.clearTimeout(timer); };
  }, [lang]);
  return useMemo(() => ({
    specialty: (text: string): string => names.specialties[text] ?? text,
    test: (text: string): string => names.tests[text] ?? text,
  }), [names]);
}
