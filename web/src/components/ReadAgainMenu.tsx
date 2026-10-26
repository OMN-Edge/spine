import { useEffect, useRef, useState } from 'react';
import { type Page } from '../api';
import { useAiReading } from './AiReading';
import ModelPicker, { useModels } from './ModelPicker';
import { loadReading, whereTo } from './aiTarget';
import { useI18n } from '../i18n';

/**
 * "Read again", beside Review: a menu with the two ways to read again, which are different things.
 *   - **Read page with AI**: this page's *image* goes to a model, which replaces the page's text. Sends an
 *     image off the host, so the panel says where.
 *   - **Read whole document**: the whole reading again for this document's pages, the way an upload does
 *     it with this server's settings (the text layer, then OCR, then a model for what is left, depending on
 *     how it is set up). The grouping is kept. Useful after an update, when the pages are grouped right and
 *     only the reading and the details should be redone.
 * Either one then extracts the document's details again. Choosing one opens a panel with what it will do
 * and a model picker; nothing runs until it is confirmed. A fragment, not a block: it sits in a row with
 * the Review button and its panel takes a line of its own.
 */
type Action = 'page' | 'document';
type Reading = { mode: 'text' | 'ocr' | 'hybrid' | 'multimodal'; ocr: boolean; images: boolean } | null;

export default function ReadAgainMenu({
  page, pages, reviewed,
}: {
  /** The page in view: the one "read page" means. */
  page: Page | undefined;
  /** All the document's pages that are not hidden: what "read whole document" reads. */
  pages: Page[];
  /** The owner has reviewed it: it goes back to review. */
  reviewed: boolean;
}) {
  const { t, tx } = useI18n();
  // Which page of this document is in view (the first is 1), not its number in the file.
  const position = Math.max(1, pages.findIndex(p => p.id === page?.id) + 1);
  const { target, busy, start } = useAiReading();
  const models = useModels();
  const [reading, setReading] = useState<Reading>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [thinking, setThinking] = useState(false);
  const [menu, setMenu] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => { loadReading().then(setReading); }, []);

  // The menu closes on a click anywhere else, and on Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const chosenEndpoint = models.find(m => m.id === model)?.endpoint;
  const where = target ? (chosenEndpoint ? whereTo({ provider: target.provider, endpoint: chosenEndpoint }) : whereTo(target)) : '';

  /** What reading the whole document does on this server, in the words of how it is set up. */
  const wholeDocument = () => {
    switch (reading?.mode) {
      case 'text': return t("It reads each page's text layer again, as an upload does here. Pages with no text layer stay empty.");
      case 'ocr': return t('It reads each page again the way an upload does here: the text layer, then local OCR for pages that have none. Nothing leaves this device but the text for the extraction.');
      case 'multimodal': return tx('It sends every page image to {where}, as an upload does here.', { where: <strong>{where}</strong> });
      case 'hybrid': return tx(reading.ocr
        ? 'It reads each page again the way an upload does here: the text layer first, then local OCR, and only pages still without text are sent as images to {where}.'
        : 'It reads each page again the way an upload does here: the text layer first, and only pages still without text are sent as images to {where}.', { where: <strong>{where}</strong> });
      default: return t('It reads each page again the way an upload does here.');
    }
  };
  const replaces = `${t("The pages' text is read again, and the title, date, provider, type, summary, tags and fields that you did not edit are replaced; the document goes back to Review. What you edited or added by hand, the grouping and your notes are kept.")}${reviewed ? ` ${t('You have reviewed it; it will need reviewing again.')}` : ''}`;

  const choose = (next: Action) => { setMenu(false); setError(''); setThinking(false); setAction(next); };
  const cancel = () => { setAction(null); setError(''); };

  const confirm = async () => {
    setError('');
    try {
      if (action === 'page' && page) await start([page.id], model, 'model', thinking);
      else if (action === 'document') await start(pages.map(p => p.id), model, 'configured');
      setAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not start'));
    }
  };

  const item = 'block w-full px-3 py-2 text-left hover:bg-gray-50 disabled:opacity-50 disabled:hover:bg-transparent';

  return (
    <>
      <span ref={box} className="relative">
        <button
          type="button" disabled={busy} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)}
          title={busy ? t('Wait for the reading to finish') : undefined}
          className="inline-flex h-full items-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {t('Read again')}
          <svg viewBox="0 0 20 20" className={`h-3.5 w-3.5 text-gray-400 transition-transform ${menu ? 'rotate-180' : ''}`} fill="currentColor" aria-hidden="true">
            <path d="M5.2 7.5a.9.9 0 011.3 0L10 11l3.5-3.5a.9.9 0 011.3 1.3l-4.2 4.2a.9.9 0 01-1.3 0L5.2 8.8a.9.9 0 010-1.3z" />
          </svg>
        </button>
        {menu && (
          <div role="menu" className="absolute right-0 z-10 mt-1 w-72 overflow-hidden rounded-xl border border-gray-200 bg-white text-sm shadow-lg">
            <button type="button" role="menuitem" disabled={!target || !page} onClick={() => choose('page')} className={item}>
              <span className="block font-medium text-gray-900">{t('Read page with AI')}</span>
              <span className="block text-xs text-gray-500">
                {target ? t('Sends page {n} to a model', { n: position }) : t('Switched off on this server')}
              </span>
            </button>
            <button type="button" role="menuitem" disabled={pages.length === 0} onClick={() => choose('document')} className={`${item} border-t border-gray-100`}>
              <span className="block font-medium text-gray-900">{t('Read whole document')}</span>
              <span className="block text-xs text-gray-500">{t('Its pages again, as an upload reads them')}</span>
            </button>
          </div>
        )}
      </span>

      {action && (
        <div className="basis-full rounded-xl border border-gray-200 bg-gray-50 p-3 text-left">
          <p className="text-sm font-medium text-gray-900">{action === 'page' ? t('Read page {n} with AI', { n: position }) : t('Read whole document')}</p>
          <p className="mt-1 text-sm text-gray-700">
            {action === 'page'
              ? tx("This sends the page image to {where} and replaces the page's text with the model's reading.", { where: <strong>{where}</strong> })
              : wholeDocument()}
          </p>
          <p className="mt-1 text-xs text-gray-500">{replaces}</p>
          <ModelPicker models={models} value={model} onChange={setModel} />
          {action === 'page' && (
            <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={thinking} onChange={e => setThinking(e.target.checked)} className="mt-0.5" />
              <span>
                <span className="font-medium text-gray-900">{t('Think harder')}</span>
                <span className="block text-xs text-gray-500">{t('The model thinks before it answers. Slower and it uses more of the model budget, but it can read handwriting and dense blocks better.')}</span>
              </span>
            </label>
          )}
          {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button
              type="button" onClick={confirm} disabled={busy}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {action === 'page' ? t('Send and read') : t('Read document')}
            </button>
            <button type="button" onClick={cancel} className="px-2 text-sm text-gray-500 hover:text-gray-700">{t('Cancel')}</button>
          </div>
        </div>
      )}
    </>
  );
}
