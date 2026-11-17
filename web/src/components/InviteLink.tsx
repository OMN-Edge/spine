import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { canShare, copyLink, shareLink } from '../share-link';

/**
 * The link a person sends to invite someone: a Copy button and, on a phone, Share, and the address itself only on request. A long address printed as small wrapped text is
 * something to select by hand; the buttons do the work.
 */
export default function InviteLink({ url }: { url: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    if (await copyLink(url)) setCopied(true); else setShown(true);
  };
  const button = 'rounded-full border border-gray-300 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void copy()} className={button}>{copied ? t('Copied') : t('Copy link')}</button>
        {canShare() && <button type="button" onClick={() => void shareLink({ url, title: 'Spine' })} className={button}>{t('Share')}</button>}
        <button type="button" onClick={() => setShown(s => !s)} aria-expanded={shown} className="text-sm text-brand-600 hover:underline">{shown ? t('Hide the link') : t('Show the link')}</button>
      </div>
      {shown && <p className="break-all select-all text-xs text-gray-500">{url}</p>}
    </div>
  );
}
