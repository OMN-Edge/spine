import { useState, useEffect } from 'react';
import { api, type ShareLink } from '../api';

export default function ShareLinks() {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    label: '',
    scope: 'all' as ShareLink['scope'],
    scope_value: '',
    expires_days: 7,
  });
  const [newUrl, setNewUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.share.list().then(setLinks).finally(() => setLoading(false));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      let scope_value: unknown = undefined;
      if (form.scope === 'tag') scope_value = form.scope_value;
      else if (form.scope === 'date_range') {
        const [from, to] = form.scope_value.split('...');
        scope_value = { from, to };
      } else if (form.scope === 'document_ids') {
        scope_value = form.scope_value.split(',').map(s => s.trim()).filter(Boolean);
      }

      const result = await api.share.create({
        label: form.label || undefined,
        scope: form.scope,
        scope_value,
        expires_days: form.expires_days,
      });

      setNewUrl(result.url);
      const updated = await api.share.list();
      setLinks(updated);
    } catch (err) {
      // The server rejects a scope it cannot fully resolve (P2), so the reason
      // has to reach the owner — otherwise the form silently does nothing.
      setNewUrl('');
      setError(err instanceof Error ? err.message : 'Could not create the link');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    await api.share.revoke(id);
    setLinks(prev => prev.map(l => l.id === id ? { ...l, revoked: true } : l));
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Share Links</h1>

      {/* Create form */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
        <h2 className="font-medium text-gray-900 mb-4">Create share link</h2>
        <form onSubmit={create} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Label (for your reference)</label>
            <input
              type="text"
              value={form.label}
              onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Dr. Popescu — cardiologie, iulie 2026"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Scope</label>
            <select
              value={form.scope}
              onChange={e => setForm(f => ({ ...f, scope: e.target.value as ShareLink['scope'] }))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All history</option>
              <option value="tag">By tag</option>
              <option value="date_range">Date range (from...to)</option>
              <option value="document_ids">Specific documents (comma-separated IDs)</option>
            </select>
          </div>

          {form.scope !== 'all' && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                {form.scope === 'tag' ? 'Tag name' : form.scope === 'date_range' ? 'Range (YYYY-MM-DD...YYYY-MM-DD)' : 'Document IDs'}
              </label>
              <input
                type="text"
                value={form.scope_value}
                onChange={e => setForm(f => ({ ...f, scope_value: e.target.value }))}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Expires in (days, max 30)</label>
            <input
              type="number"
              min={1}
              max={30}
              value={form.expires_days}
              onChange={e => setForm(f => ({ ...f, expires_days: parseInt(e.target.value) }))}
              className="w-24 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            disabled={creating}
            className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create link'}
          </button>
        </form>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}

        {newUrl && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-xs text-green-700 font-medium mb-1">Link created — copy and send to doctor:</p>
            <div className="flex items-center gap-2">
              <code className="text-sm text-green-800 break-all flex-1">{newUrl}</code>
              <button
                onClick={() => navigator.clipboard.writeText(newUrl)}
                className="text-xs text-green-600 hover:text-green-800 shrink-0"
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Existing links */}
      {!loading && links.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-gray-900 mb-3">Active links</h2>
          {links.map(link => {
            const expired = new Date(link.expires_at) < new Date();
            return (
              <div
                key={link.id}
                className={`bg-white border rounded-xl p-4 ${link.revoked || expired ? 'opacity-50 border-gray-200' : 'border-gray-200'}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {link.label ?? `${link.scope} scope`}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {link.revoked ? 'Revoked' : expired ? 'Expired' : `Expires ${link.expires_at.slice(0, 10)}`}
                      {' · '}{link.view_count} view{link.view_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                  {!link.revoked && !expired && (
                    <button
                      onClick={() => revoke(link.id)}
                      className="text-xs text-red-500 hover:text-red-700 shrink-0"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
