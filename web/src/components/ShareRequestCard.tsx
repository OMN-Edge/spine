import { useState } from 'react';
import { api, type ShareRequest } from '../api';
import { useI18n } from '../i18n';

/**
 * One browser asking to open a share link, with the buttons that decide it. `note`, the address and the browser name
 * are the visitor's own words: shown as text, and the owner is told so, since anyone holding the link can write them.
 */
export default function ShareRequestCard({ request, onDecided }: { request: ShareRequest; onDecided: (r: ShareRequest) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    setError('');
    try {
      const { status } = await api.share.decide(request.id, decision);
      onDecided({ ...request, status, decided_at: new Date().toISOString() });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-sm font-medium text-gray-900">{request.link_label ?? t('A share link')}</p>
      <dl className="mt-2 text-xs text-gray-600 space-y-1">
        <div><dt className="inline text-gray-500">{t('Asked')}: </dt><dd className="inline">{new Date(request.requested_at).toLocaleString()}</dd></div>
        {request.ip_address && <div><dt className="inline text-gray-500">{t('From address')}: </dt><dd className="inline">{request.ip_address}</dd></div>}
        {request.user_agent && <div><dt className="inline text-gray-500">{t('Browser')}: </dt><dd className="inline break-words">{request.user_agent}</dd></div>}
        {request.note && <div><dt className="inline text-gray-500">{t('Their note')}: </dt><dd className="inline break-words">{request.note}</dd></div>}
      </dl>
      <p className="text-xs text-gray-500 mt-2">{t('The address, browser and note are written by whoever opened the link. They do not prove who it is.')}</p>

      {request.status === 'pending' ? (
        <div className="flex gap-2 mt-3">
          <button disabled={busy || !request.link_active} onClick={() => decide('approve')} className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">{t('Approve')}</button>
          <button disabled={busy} onClick={() => decide('deny')} className="border border-gray-200 text-gray-700 rounded-lg px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50">{t('Deny')}</button>
        </div>
      ) : (
        <div className="flex items-center gap-3 mt-3">
          <span className={`text-xs font-medium ${request.status === 'approved' ? 'text-green-700' : 'text-gray-500'}`}>
            {request.status === 'approved' ? t('Approved') : t('Denied')}
          </span>
          {request.status === 'approved' && (
            <button disabled={busy} onClick={() => decide('deny')} className="text-xs text-red-500 hover:text-red-700">{t('Withdraw access')}</button>
          )}
        </div>
      )}
      {!request.link_active && request.status === 'pending' && <p className="text-xs text-gray-500 mt-2">{t('This link is no longer active.')}</p>}
      {error && <p className="text-xs text-red-600 mt-2" role="alert">{error}</p>}
    </div>
  );
}
