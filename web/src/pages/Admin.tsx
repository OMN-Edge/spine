import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, ApiError, type AdminDashboard } from '../api';
import { useAuth } from '../auth';
import AdminAccounts from '../components/AdminAccounts';
import AdminDashboardView from '../components/AdminDashboard';
import AdminSettings from '../components/AdminSettings';
import AdminFairUse from '../components/AdminFairUse';
import AdminInvoices from '../components/AdminInvoices';
import AdminCatalog from '../components/AdminCatalog';
import AdminEfactura from '../components/AdminEfactura';
import AdminWithdrawals from '../components/AdminWithdrawals';
import AdminSubscriptions from '../components/AdminSubscriptions';
import { useI18n } from '../i18n';
import '@fontsource/literata/400.css';
import { LogoMark } from '../components/Logo';

/**
 * The operator's pages, `/admin` and the ones under it, apart from the app: no records and no menu of the app's, only the numbers (`server/src/dashboard.ts`) and what the
 * operator decides, in a menu of its own: the overview, the subscriptions (and the withdrawals), the invoices (and the e-Factura link), the accounts waiting for approval and the settings.
 * It signs in as everything else does and comes back here. Who may see it is the server's to say (`SPINE_ADMIN_EMAILS`, and `SPINE_MARKETING_EMAILS` for
 * the numbers); anyone else is told it is not for them and sees nothing. It is not linked from anywhere and is kept out of search (`robots.txt`).
 */
export default function Admin() {
  const { t } = useI18n();
  const { authenticated, email } = useAuth();
  const location = useLocation();
  const menu = [
    { to: '/admin', label: t('Overview') },
    { to: '/admin/subscriptions', label: t('Subscriptions') },
    { to: '/admin/products', label: t('Products') },
    { to: '/admin/invoices', label: t('Invoices') },
    { to: '/admin/accounts', label: t('Accounts') },
    { to: '/admin/settings', label: t('Settings') },
  ];
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'forbidden' | 'failed'>('loading');
  const [at, setAt] = useState<Date | null>(null);

  const reload = () => api.admin.dashboard()
    .then(d => { setData(d); setState('ok'); setAt(new Date()); })
    .catch(err => setState(err instanceof ApiError && err.status === 403 ? 'forbidden' : 'failed'));
  useEffect(() => {
    if (!authenticated) return;
    let live = true;
    const load = () => api.admin.dashboard()
      .then(d => { if (live) { setData(d); setState('ok'); setAt(new Date()); } })
      .catch(err => { if (live) setState(err instanceof ApiError && err.status === 403 ? 'forbidden' : 'failed'); });
    void load();
    // The server works the numbers out at most once a minute; looking more often changes nothing.
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [authenticated]);

  if (!authenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <div className="min-h-screen bg-paper text-ink antialiased">
      <header className="border-b border-ink/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="inline-flex items-center gap-2">
            <LogoMark className="h-7 w-7 text-accent" />
            <span className="font-display text-xl font-medium">Spine</span>
            <span className="rounded-full border border-ink/15 px-2.5 py-0.5 text-xs font-medium uppercase tracking-[0.12em] text-ink/70">{t('Admin')}</span>
          </span>
          <div className="flex items-center gap-4 text-sm text-ink/60">
            {at && <span className="hidden md:inline">{t('Updated {time}', { time: at.toLocaleTimeString() })}</span>}
            {email && <span className="hidden sm:inline">{email}</span>}
            <Link to="/" className="rounded-full border border-ink/20 px-4 py-1.5 font-medium text-ink hover:bg-ink/5">{t('Back to Spine')}</Link>
          </div>
        </div>
      </header>
      <nav aria-label={t('Admin')} className="border-b border-ink/10">
        <div className="mx-auto flex max-w-6xl flex-wrap gap-x-1 px-4 sm:px-6">
          {menu.map(item => (
            <NavLink key={item.to} to={item.to} end={item.to === '/admin'} className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium ${isActive ? 'border-accent text-ink' : 'border-transparent text-ink/60 hover:text-ink'}`}>{item.label}</NavLink>
          ))}
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        {state === 'loading' && <p className="text-ink/50">{t('Loading…')}</p>}
        {state === 'forbidden' && <p className="font-display text-2xl">{t('This page is for the administrator.')}</p>}
        {state === 'failed' && <p className="text-red-700">{t('Could not load the numbers.')}</p>}
        {state === 'ok' && data && (
          <Routes>
            <Route index element={<AdminDashboardView data={data} />} />
            <Route path="subscriptions" element={<><AdminSubscriptions /><div className="mt-14"><AdminWithdrawals /></div></>} />
            <Route path="products" element={<AdminCatalog />} />
            <Route path="invoices" element={<><AdminInvoices /><div className="mt-14"><AdminEfactura /></div></>} />
            <Route path="accounts" element={<AdminAccounts />} />
            <Route path="settings" element={<><AdminSettings onChanged={() => void reload()} /><div className="mt-14"><AdminFairUse /></div></>} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
