import { useState } from 'react';
import { api } from '../api';
import { useBilling } from '../billing';
import { deviceFetch } from '../core/client';
import { makeClaimPdf, type ClaimDocument } from '../claim-pdf';
import { sheetFonts, sheetLanguage } from '../share-sheet';
import { useI18n } from '../i18n';

/**
 * "Download as files" beside "Create link" (T-25): the documents the chosen scope picks, as one PDF for an insurer's portal or a doctor who wants files, with a cover that lists them. It takes the
 * same scope as the link would and resolves it the same way, on the device; nothing is sent anywhere. Part of Premium and Family, the same as translation for a link: other plans see it said.
 */
export default function ClaimExport({ scope, scopeValue, ready, language, name }: { scope: string; scopeValue: unknown; ready: boolean; language: string; name?: string | null }) {
  const { t, lang } = useI18n();
  const billing = useBilling();
  const [summaries, setSummaries] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // An instance with no plans limits nothing; with plans, the plan says (`features.files_export`).
  const allowed = !billing?.enabled || billing.features?.files_export !== false;
  const target = sheetLanguage(language, lang);

  const download = async () => {
    setError(''); setBusy(t('Making the PDF…'));
    try {
      const docs = await api.share.scopeDocuments(scope, scopeValue);
      const documents: ClaimDocument[] = [];
      for (const d of docs) {
        setBusy(t('Making the PDF… {done} of {total}', { done: documents.length + 1, total: docs.length }));
        const res = await deviceFetch(`/api/documents/${d.id}/pdf`);
        const pdf = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
        // A summary in the reader's language, only where it was asked for and the document is in another; the same translation as the page's, kept for next time.
        let summary: string | null = null;
        if (summaries && d.language !== target) {
          const done = await api.documents.translation(d.id, target, 'head').catch(() => null);
          summary = done?.ai_summary ?? null;
        }
        documents.push({ title: d.title, doc_date: d.doc_date, provider: d.provider, doc_type: d.doc_type, pages: d.page_end - d.page_start + 1, pdf, summary });
      }
      const bytes = await makeClaimPdf({ name, language: target, documents }, await sheetFonts());
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      link.download = 'spine-documents.pdf';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('The PDF could not be made.'));
    } finally { setBusy(''); }
  };

  return (
    <div className="rounded-lg border border-gray-200 p-3 space-y-2">
      <p className="text-sm font-medium text-gray-900">{t('Or download them as files')}</p>
      <p className="text-xs text-gray-500">{t('One PDF with a cover that lists every document, then their pages in date order. For an insurer’s portal or a doctor who wants files. Made on your device.')}</p>
      {allowed ? (
        <>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={summaries} onChange={e => setSummaries(e.target.checked)} className="mt-0.5" />
            <span>{t('Add a translated summary before each document in another language')}<span className="block text-xs text-gray-500">{t('A machine translation, marked as one. Off unless you tick it.')}</span></span>
          </label>
          <button type="button" disabled={!ready || !!busy} onClick={() => void download()} className="rounded-full border border-gray-300 px-4 py-1.5 text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-50">{busy || t('Download as files')}</button>
        </>
      ) : <p className="text-sm text-gray-600" role="note">{t('Part of Premium')}</p>}
      {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
    </div>
  );
}
