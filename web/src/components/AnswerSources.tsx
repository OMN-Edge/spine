import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ChatSource } from '../api';
import { useI18n } from '../i18n';
import { documentTitle } from '../titles';

/** What a cited section is called on the page. */
export const SECTION_NAMES: Record<string, string> = {
  summary: 'Summary', notes: 'Notes', doctors: 'Doctors', results: 'Measurements', fields: 'Extracted fields', chain: 'Connected documents',
};

/** The source a citation in the text stands for: the exact label, or the document if only a section was shown. */
export function sourceFor(label: string, sources: ChatSource[]): ChatSource | undefined {
  return sources.find(s => s.label === label) ?? sources.find(s => s.label.split('.')[0] === label.split('.')[0]);
}

/** Sources in the order the answer first cites them, then any it did not cite; each gets the number the text shows. */
export function numbered(text: string, sources: ChatSource[]): ChatSource[] {
  const order: ChatSource[] = [];
  for (const [, label] of text.matchAll(/\[([DTCS]\d+(?:\.[a-z]+)?)\]/g)) {
    const source = sourceFor(label, sources);
    if (source && !order.includes(source)) order.push(source);
  }
  for (const source of sources) if (!order.includes(source)) order.push(source);
  return order;
}

export const chipClass = 'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded px-1 text-[10px] font-semibold bg-blue-50 text-blue-700';

/** The name of a source: the document (in the reader's language where there is one) and the part of it, if a part was cited. */
export function useSourceName(titleOf?: (source: ChatSource) => string | null | undefined) {
  const { t } = useI18n();
  return (source: ChatSource) => {
    const title = titleOf?.(source);
    const name = title ? documentTitle({ ...source, title }, t) : documentTitle(source, t);
    return `${name}${source.section ? ` · ${t(SECTION_NAMES[source.section] ?? source.section)}` : ''}`;
  };
}

/**
 * The owner's cited documents named in the interface language: what is already translated comes at once, the rest is translated in
 * the background and asked for again shortly. Null for a document already in that language, and until the title is ready.
 */
export function useOwnerTitles(ids: string[]): (source: ChatSource) => string | null {
  const { lang } = useI18n();
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const key = [...new Set(ids)].join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    let timer: number | undefined;
    let tries = 0;
    const load = () => api.documents.titles(key.split(','), lang)
      .then(r => { if (!live) return; setTitles(r.titles); if (r.pending && tries++ < 8) timer = window.setTimeout(load, 3000); })
      .catch(() => {});
    load();
    return () => { live = false; window.clearTimeout(timer); };
  }, [key, lang]);
  return source => titles[source.id] ?? null;
}

/**
 * The list the numbers in an answer refer to, set apart from the answer so it reads as its own part: a heading, and one row for each
 * source with its number, the document and the part of it. Used by the owner's chat and a share recipient's, so they look the same.
 */
export default function AnswerSources({ sources, hrefOf, onFollow, titleOf, owner }: {
  sources: ChatSource[];
  hrefOf: (source: ChatSource) => string;
  onFollow?: () => void;
  /** A share recipient's names come from the page's own list. */
  titleOf?: (source: ChatSource) => string | null | undefined;
  /** The owner's: fetch the titles in the interface language. */
  owner?: boolean;
}) {
  const { t } = useI18n();
  const fetched = useOwnerTitles(owner ? sources.map(s => s.id) : []);
  const nameOf = useSourceName(owner ? fetched : titleOf);
  if (sources.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">{t('Sources')}</p>
      <ol className="space-y-1.5">
        {sources.map((source, n) => (
          <li key={source.label}>
            <Link to={hrefOf(source)} onClick={onFollow} className="flex items-start gap-2 text-xs text-gray-800 hover:text-blue-700">
              <span className={`mt-px ${chipClass}`}>{n + 1}</span>
              <span className="min-w-0 break-words">{nameOf(source)}{source.doc_date ? <span className="text-gray-500"> · {source.doc_date}</span> : null}</span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
