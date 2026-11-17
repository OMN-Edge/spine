import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useI18n } from '../i18n';

/**
 * A way to the operator's page for the accounts that have one (T-23), so the operator does not have to remember its address. Nothing is drawn for anyone else, and the server, not this
 * card, is what keeps the page to them.
 */
export default function AdministrationCard() {
  const { t } = useI18n();
  const [role, setRole] = useState<'admin' | 'reader' | null>(null);
  useEffect(() => { api.admin.role().then(r => setRole(r.role)).catch(() => setRole(null)); }, []);
  if (!role) return null;
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
      <h3 className="font-medium text-gray-900 mb-1">{t('Administration')}</h3>
      <p className="text-sm text-gray-500 mb-3">{role === 'admin' ? t('The accounts waiting for approval, the subscriptions, the invoices, the products and the settings of this Spine.') : t('The numbers of this Spine, read only.')}</p>
      <Link to="/admin" className="text-sm text-brand-600 hover:underline">{t('Open the operator’s page')}</Link>
    </section>
  );
}
