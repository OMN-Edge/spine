import { Link } from 'react-router-dom';
import { msg, useI18n } from '../i18n';
import AiLabel from './AiLabel';
import { documentTitle } from '../titles';

export const DOC_TYPE_LABELS: Record<string, string> = {
  lab_result: msg('Lab'),
  discharge_note: msg('Discharge'),
  vaccination: msg('Vaccine'),
  imaging: msg('Imaging'),
  prescription: msg('Prescription'),
  consultation_note: msg('Consultation'),
  other: msg('Other'),
};

const DOC_TYPE_COLORS: Record<string, string> = {
  lab_result: 'bg-blue-100 text-blue-700',
  discharge_note: 'bg-orange-100 text-orange-700',
  vaccination: 'bg-green-100 text-green-700',
  imaging: 'bg-purple-100 text-purple-700',
  prescription: 'bg-yellow-100 text-yellow-700',
  consultation_note: 'bg-teal-100 text-teal-700',
  other: 'bg-gray-100 text-gray-600',
};

export default function DocumentCard({ doc, to, owner = true }: {
  doc: { title: string | null; doc_type: string | null; provider: string | null; doc_date: string | null; ai_summary: string | null; page_start: number; page_end: number; reviewed?: boolean; to_check?: number };
  to: string;
  /** The owner sees whether a document is reviewed and where it sits in the upload; a recipient has no use for either. */
  owner?: boolean;
}) {
  const { t, tn } = useI18n();
  const typeLabel = doc.doc_type ? t(DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type) : t('Unknown');
  const typeColor = doc.doc_type ? DOC_TYPE_COLORS[doc.doc_type] ?? 'bg-gray-100 text-gray-600' : 'bg-gray-100 text-gray-600';

  return (
    <Link
      to={to}
      className="block bg-white border border-gray-200 rounded-xl p-5 hover:border-blue-300 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${typeColor}`}>{typeLabel}</span>
            {owner && !doc.reviewed && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                {t('Unreviewed')}
              </span>
            )}
            {owner && !!doc.to_check && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700" title={t('Read with low confidence, often from handwriting or a faded line: check these against the page')}>
                {tn(doc.to_check, '{n} value to check', '{n} values to check')}
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-gray-900 truncate">{documentTitle(doc, t)}</p>
          {doc.title && doc.provider && <p className="text-xs text-gray-500 truncate">{doc.provider}</p>}
          {doc.ai_summary && (
            <p className="text-sm text-gray-500 mt-1 line-clamp-2"><AiLabel className="mr-1.5" />{doc.ai_summary}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm text-gray-900">{doc.doc_date ?? '—'}</p>
          {owner && (
            <p className="text-xs text-gray-400 mt-0.5">
              {t('p. {from}–{to}', { from: doc.page_start, to: doc.page_end })}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

