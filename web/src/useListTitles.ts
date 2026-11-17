import { useEffect, useState } from 'react';
import { api } from './api';
import { useI18n } from './i18n';

/** The most titles one request asks for (the core's limit); a longer list is asked for in turns. */
const CHUNK = 60;

/**
 * The titles of the documents a list shows, in the interface language: what is kept comes at once, and a document not yet translated is
 * translated in the background and asked for again shortly. Only titles that still match their document are given, so a title is never one
 * that was translated from different words. A list that shows part of its documents at a time passes the ones on screen.
 * Returns the title to show for a document: the translation where there is one, else the document's own.
 */
export function useListTitles(ids: string[]): <T extends { id: string; title: string | null }>(doc: T) => string | null {
  const { lang } = useI18n();
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const key = [...new Set(ids)].join(',');
  useEffect(() => { setTitles({}); }, [lang]);
  useEffect(() => {
    if (!key) return;
    let live = true;
    let timer: number | undefined;
    let tries = 0;
    const all = key.split(',');
    const load = async () => {
      let pending = false;
      for (let i = 0; i < all.length && live; i += CHUNK) {
        const answer = await api.documents.titles(all.slice(i, i + CHUNK), lang).catch(() => null);
        if (!answer || !live) continue;
        pending ||= answer.pending;
        setTitles(held => ({ ...held, ...answer.titles }));
      }
      if (live && pending && tries++ < 8) timer = window.setTimeout(() => { void load(); }, 3000);
    };
    void load();
    return () => { live = false; window.clearTimeout(timer); };
  }, [key, lang]);
  return doc => titles[doc.id] ?? doc.title;
}
