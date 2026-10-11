import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Document } from '../api';
import { documentByline, documentTitle } from '../titles';

export default function PublicShareView() {
  const { token } = useParams<{ token: string }>();
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    api.publicShare.documents(token)
      .then(setDocs)
      .catch(err => setError(err.message ?? 'This link is no longer active.'))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center max-w-sm">
          <p className="text-gray-900 font-medium mb-2">Link unavailable</p>
          <p className="text-gray-500 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-gray-900">Medical History</h1>
          <p className="text-sm text-gray-400 mt-1">Read-only shared view · {docs.length} documents</p>
        </div>

        {docs.length === 0 ? (
          <p className="text-gray-400">No documents in this share.</p>
        ) : (
          <div className="space-y-4">
            {docs.map(doc => (
              <div key={doc.id} className="bg-white border border-gray-200 rounded-xl p-5">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">{documentTitle(doc)}</p>
                    <p className="text-sm text-gray-500 mt-0.5">{documentByline(doc)}</p>
                  </div>
                </div>
                {doc.ai_summary && (
                  <p className="text-sm text-gray-700 leading-relaxed mb-3">{doc.ai_summary}</p>
                )}
                {doc.user_notes && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs font-medium text-gray-500 mb-1">Notes</p>
                    <p className="text-sm text-gray-700">{doc.user_notes}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-gray-300 text-center mt-10">
          This link was shared for a specific consultation and expires automatically.
        </p>
      </div>
    </div>
  );
}
