import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ShareRequest } from '../api';
import ShareRequestCard from '../components/ShareRequestCard';
import { useI18n } from '../i18n';

/** What the mailed link opens (signed in first): one request, to approve or deny. Nothing changes until a button is pressed. */
export default function ShareRequestPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const [request, setRequest] = useState<ShareRequest | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (id) api.share.request(id).then(setRequest).catch(() => setError(t('This request was not found.')));
  }, [id, t]);

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-semibold text-gray-900 mb-2">{t('Someone is waiting for your approval')}</h1>
      <p className="text-sm text-gray-500 mb-6">{t('They opened a link you shared. Nothing is shown to them until you approve, and only in the browser that asked.')}</p>
      {error ? <p className="text-sm text-red-600" role="alert">{error}</p>
        : !request ? <p className="text-sm text-gray-400">{t('Loading…')}</p>
        : <ShareRequestCard request={request} onDecided={setRequest} />}
      <p className="mt-6 text-sm"><Link to="/share" className="text-blue-600">{t('All share links')}</Link></p>
    </div>
  );
}
