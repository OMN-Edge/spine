import { useState } from 'react';
import { useI18n } from '../i18n';

/**
 * Puts a short report on the clipboard for the person to send to support. Where the browser refuses the clipboard, the report is shown to
 * be selected and copied by hand.
 */
export default function CopyDetails({ report }: { report: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setState('copied');
    } catch {
      setState('manual');
    }
  };
  return (
    <div>
      <button type="button" onClick={() => void copy()} className="w-full rounded-full border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50">
        {state === 'copied' ? t('Copied') : t('Copy details for support')}
      </button>
      {state === 'manual' && (
        <textarea readOnly rows={7} value={report} aria-label={t('Details for support')} onFocus={e => e.currentTarget.select()}
          className="mt-3 w-full rounded-lg border border-gray-300 bg-white p-2 font-mono text-xs text-gray-700" />
      )}
    </div>
  );
}
