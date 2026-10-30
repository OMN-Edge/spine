import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Link, NavLink, useNavigate, useLocation, useParams, Navigate } from 'react-router-dom';
import { api } from './api';
import { AuthContext, useAuth } from './auth';
import Login from './pages/Login';
import Landing from './pages/Landing';
import Register from './pages/Register';
import Verify from './pages/Verify';
import Forgot from './pages/Forgot';
import Pair from './pages/Pair';
import Reset from './pages/Reset';
import Account from './pages/Account';
import Timeline from './pages/Timeline';
import Upload from './pages/Upload';
import UploadPages from './pages/UploadPages';
import ReviewQueue from './pages/ReviewQueue';
import DocumentPage from './pages/DocumentPage';
import Search from './pages/Search';
import Trends from './pages/Trends';
import Episodes from './pages/Episodes';
import Scan from './pages/Scan';
import LegalPage from './pages/LegalPage';
import ConsentGate from './pages/ConsentGate';
import VaultSetup from './pages/VaultSetup';
import { vaultState } from './crypto/vault-state';
import UnlockScreen from './components/UnlockScreen';
import SyncNotice from './components/SyncNotice';
import SaveStatus from './components/SaveStatus';
import DemoBanner from './components/DemoBanner';
import DemoCarryOver from './components/DemoCarryOver';
import { UnsavedChangesError, device } from './core/client';
import Doctors from './pages/Doctors';
import Library from './pages/Library';
import DoctorPage from './pages/DoctorPage';
import ShareLinks from './pages/ShareLinks';
import ChatPanel from './components/ChatPanel';
import ReauthDialog from './components/ReauthDialog';
import { ChatProvider, useChat } from './components/ChatProvider';
import PublicShareView from './pages/PublicShareView';
import ShareRequestPage from './pages/ShareRequest';
import ShareLinkDetail from './pages/ShareLinkDetail';
import { Wordmark } from './components/Logo';
import { LanguageSwitcher, msg, useI18n } from './i18n';
import { ThemeSwitcher } from './components/ThemeSwitcher';

const NAV_LINKS = [
  { to: '/', label: msg('Timeline') },
  { to: '/episodes', label: msg('Episodes') },
  { to: '/upload', label: msg('Upload') },
  { to: '/review', label: msg('Review') },
  { to: '/trends', label: msg('Trends') },
  { to: '/doctors', label: msg('Doctors') },
  { to: '/library', label: msg('Library') },
  { to: '/search', label: msg('Search') },
  { to: '/share', label: msg('Share links') },
];
/** What the demo leaves out: there is no account to upload into or to share from, and nothing in it is kept. */
const NOT_IN_DEMO = new Set(['/upload', '/share']);

/**
 * Whether the person signed out on purpose, as opposed to a session that ended where they were. A session that ended sends them back to
 * the page they were on after they sign in again; signing out is a choice to leave, so the next sign-in starts at the home page. Said
 * here, in one place, so the answer does not depend on which of two redirects (the sign-out's own and the guard's) runs last.
 */
let signedOutOnPurpose = false;

function Layout({ children }: { children: React.ReactNode }) {
  const { email, setAuthenticated, demo, leaveDemo, demoUploads } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const chat = useChat();

  // A link was followed: the menu has done its job.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Signing out drops what is on this device, so it does not go ahead over changes the vault does not have: the person is asked.
  const [losing, setLosing] = useState(false);
  const logout = async (force = false) => {
    try {
      await api.auth.logout(force);
    } catch (err) {
      if (err instanceof UnsavedChangesError) { setLosing(true); return; }
      throw err;
    }
    setLosing(false);
    signedOutOnPurpose = true;
    setAuthenticated(false);
    navigate('/login');
  };

  const leave = async () => { await leaveDemo(); navigate('/'); };
  // Where the operator lets visitors read files of their own, the demo has Upload too.
  const links = demo ? NAV_LINKS.filter(link => !NOT_IN_DEMO.has(link.to) || (link.to === '/upload' && demoUploads)) : NAV_LINKS;

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm ${isActive ? 'text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900'}`;

  return (
    <div className="min-h-screen bg-gray-50">
      {losing && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="losing-text" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-w-md rounded-lg bg-white p-5 shadow-lg">
            <p id="losing-text" className="text-sm text-gray-800">{t('Some of your latest changes are not saved yet. If you sign out now, they will be lost.')}</p>
            <div className="mt-4 flex flex-wrap justify-end gap-3">
              <button type="button" autoFocus onClick={() => setLosing(false)} className="rounded-full bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">{t('Keep this page open')}</button>
              <button type="button" onClick={() => void logout(true)} className="rounded-full border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">{t('Sign out and lose them')}</button>
            </div>
          </div>
        </div>
      )}
      <nav className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 py-3 flex items-center gap-6">
          <Link to="/" className="mr-2 xl:mr-4" aria-label={t('Spine, home')}><Wordmark /></Link>

          {/* wide screens (1280px and up, where it fits): everything in one row */}
          <div className="hidden xl:flex items-center gap-6 flex-1">
            {links.map(link => (
              <NavLink key={link.to} to={link.to} end={link.to === '/'} className={linkClass}>{t(link.label)}</NavLink>
            ))}
            <LanguageSwitcher className="ml-auto" />
            <ThemeSwitcher />
            {demo ? (
              <button onClick={() => void leave()} className="text-sm text-gray-500 hover:text-gray-900">{t('Leave the demo')}</button>
            ) : (
              <>
                <Link to="/account" className="text-sm text-gray-500 hover:text-gray-900 truncate max-w-[16rem]">{email}</Link>
                <button onClick={() => void logout()} className="text-sm text-gray-500 hover:text-gray-900">{t('Sign out')}</button>
              </>
            )}
          </div>

          {/* narrow screens: a menu button */}
          <button
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            aria-expanded={menuOpen}
            aria-controls="nav-menu"
            aria-label={menuOpen ? t('Close menu') : t('Open menu')}
            className="xl:hidden ml-auto -mr-2 p-2 rounded-lg text-gray-600 hover:bg-gray-100"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>

        {menuOpen && (
          <div id="nav-menu" className="xl:hidden border-t border-gray-100 px-4 pb-3">
            {links.map(link => (
              <NavLink
                key={link.to} to={link.to} end={link.to === '/'}
                className={({ isActive }) => `block py-3 text-base border-b border-gray-100 ${isActive ? 'text-gray-900 font-medium' : 'text-gray-600'}`}
              >
                {t(link.label)}
              </NavLink>
            ))}
            {!demo && (
              <Link to="/account" className="block py-3 text-base text-gray-600 border-b border-gray-100 truncate">
                {t('Account')} <span className="text-gray-500">· {email}</span>
              </Link>
            )}
            <div className="py-3 flex items-center gap-2"><LanguageSwitcher /><ThemeSwitcher /></div>
            {demo
              ? <button onClick={() => void leave()} className="block w-full text-left py-3 text-base text-gray-600">{t('Leave the demo')}</button>
              : <button onClick={() => void logout()} className="block w-full text-left py-3 text-base text-gray-600">{t('Sign out')}</button>}
          </div>
        )}
      </nav>
      {demo && <DemoBanner />}
      {/* With the chat open beside it, the page gives it room instead of sitting under it. */}
      <main className={`max-w-6xl mx-auto px-4 sm:px-6 py-6 pb-24 sm:py-8 transition-[margin] duration-200 ${chat?.enabled && chat.open ? 'sm:mr-[26.5rem] sm:max-w-none' : ''}`}>{children}</main>
      <ChatPanel />
    </div>
  );
}

/** The document page used to live under /review; old links and bookmarks still arrive. */
function ReviewRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/documents/${id}`} replace />;
}

function PrivateRoute({ children, inDemo = true }: { children: React.ReactNode; inDemo?: boolean }) {
  const { t } = useI18n();
  const { authenticated, consentNeeded, consentGiven, vaultNeeded, vaultMade, deviceState, deviceOpened, setAuthenticated, demo } = useAuth();
  const location = useLocation();
  // The demo has no account: no consent, vault or sign-in to ask for, and the screens that need an account are not there.
  if (demo) return inDemo ? <Layout>{children}</Layout> : <Navigate to="/" replace />;
  // Where they were going, so signing in lands there: a mailed link to a request is the case that matters.
  // Until the server has said what this account still has to agree to, nothing is asked of it.
  if (authenticated && consentNeeded === undefined) return <div className="min-h-screen flex items-center justify-center text-gray-400">{t('Loading…')}</div>;
  if (authenticated && consentNeeded) return <ConsentGate need={consentNeeded} done={consentGiven} />;
  if (authenticated && vaultNeeded) return <VaultSetup done={vaultMade} />;
  // The records are sealed in the vault and open only on this device, with the key made from the master password.
  if (authenticated && deviceState === 'starting') return <div className="min-h-screen flex items-center justify-center text-gray-400">{t('Opening…')}</div>;
  if (authenticated && deviceState === 'locked') return <UnlockScreen opened={deviceOpened} signOut={() => setAuthenticated(false)} />;
  return authenticated ? <Layout><SaveStatus /><SyncNotice /><DemoCarryOver />{children}</Layout> : <Navigate to="/login" replace state={{ from: signedOutOnPurpose ? '/' : location.pathname }} />;
}

/** Signing in from the demo ends it first: the device's core is the demo's until then. */
function NotInDemo({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const { demo, leaveDemo } = useAuth();
  useEffect(() => { if (demo) void leaveDemo(); }, [demo, leaveDemo]);
  return demo ? <div className="min-h-screen flex items-center justify-center text-gray-400">{t('Loading…')}</div> : <>{children}</>;
}

export default function App() {
  const { t } = useI18n();
  const [authenticated, setAuthenticatedState] = useState(false);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  // What this account still has to agree to; asked for whenever a sign-in happens.
  const [consentNeeded, setConsentNeeded] = useState<{ health: boolean; terms: boolean } | null | undefined>(undefined);
  // An account with no vault is asked to make one (after consent, before anything else).
  const [vaultNeeded, setVaultNeeded] = useState(false);
  // Whether the records are open on this device: 'starting' while the key is handed to the core, 'locked' when it must be asked for.
  const [deviceState, setDeviceState] = useState<'starting' | 'locked' | 'open'>('starting');
  // The demo: the device's core, started with no vault, holding the sample records until the page is left.
  const [demo, setDemo] = useState(false);
  const [demoUploads, setDemoUploads] = useState<{ uploads: number; pages: number } | null>(null);
  const [demoAgreed, setDemoAgreed] = useState(false);
  const startDemo = useCallback(async (language: 'en' | 'ro') => {
    const limits = await device.openDemo();
    try { await api.demo.load(language); } catch (err) { await device.lock(true); throw err; }
    setDemoUploads(limits);
    setDemoAgreed(false);
    setDemo(true);
  }, []);
  const leaveDemo = useCallback(async () => { await device.lock(true); setDemo(false); setDemoUploads(null); setDemoAgreed(false); }, []);

  const setAuthenticated = (value: boolean, who = '') => {
    if (value) signedOutOnPurpose = false;
    setAuthenticatedState(value);
    setEmail(value ? who : '');
    if (value) vaultState.setEmail(who);
  };

  useEffect(() => {
    api.auth.me()
      .then(r => setAuthenticated(r.authenticated, r.email))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Whenever someone is signed in, ask what they still have to agree to (a new account, or a text that changed).
  useEffect(() => {
    if (!authenticated) { setConsentNeeded(undefined); return; }
    api.auth.me()
      .then(r => {
        setConsentNeeded(r.consent_needed && (r.consent_needed.health || r.consent_needed.terms) ? r.consent_needed : null);
        const needed = r.vault === false;
        setVaultNeeded(needed);
      })
      .catch(() => {});
  }, [authenticated]);

  // The sign-in left the master key; once consent allows the request and there is a vault, open it with it.
  useEffect(() => {
    if (!authenticated) { setDeviceState('starting'); return; }
    if (consentNeeded !== null || vaultNeeded) return;
    vaultState.openStashed().catch(() => {});
    vaultState.startDevice().then(setDeviceState).catch(() => setDeviceState('locked'));
  }, [authenticated, consentNeeded, vaultNeeded]);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-400">{t('Loading…')}</div>;

  return (
    <AuthContext.Provider value={{ authenticated, email, setAuthenticated, consentNeeded, consentGiven: () => setConsentNeeded(null), vaultNeeded, vaultMade: () => setVaultNeeded(false), deviceState, deviceOpened: () => setDeviceState('open'), demo, startDemo, leaveDemo, demoUploads, demoAgreed, agreeDemo: () => setDemoAgreed(true) }}>
      <ChatProvider authenticated={authenticated || demo}>
      <ReauthDialog />
      <Routes>
        <Route path="/login" element={<NotInDemo><Login /></NotInDemo>} />
        <Route path="/register" element={<NotInDemo><Register /></NotInDemo>} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/privacy" element={<LegalPage doc="privacy" />} />
        <Route path="/terms" element={<LegalPage doc="terms" />} />
        <Route path="/purpose" element={<LegalPage doc="purpose" />} />
        <Route path="/pair" element={<NotInDemo><Pair /></NotInDemo>} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/share/:id" element={<PublicShareView />} />
        <Route path="/" element={authenticated || demo ? <PrivateRoute><Timeline /></PrivateRoute> : <Landing />} />
        <Route path="/upload" element={<PrivateRoute inDemo={!!demoUploads}><Upload /></PrivateRoute>} />
        <Route path="/uploads/:id" element={<PrivateRoute><UploadPages /></PrivateRoute>} />
        <Route path="/review" element={<PrivateRoute><ReviewQueue /></PrivateRoute>} />
        <Route path="/documents/:id" element={<PrivateRoute><DocumentPage /></PrivateRoute>} />
        <Route path="/review/:id" element={<ReviewRedirect />} />
        <Route path="/trends" element={<PrivateRoute><Trends /></PrivateRoute>} />
        <Route path="/episodes" element={<PrivateRoute><Episodes /></PrivateRoute>} />
        <Route path="/scan" element={<PrivateRoute inDemo={false}><Scan /></PrivateRoute>} />
        <Route path="/doctors" element={<PrivateRoute><Doctors /></PrivateRoute>} />
        <Route path="/library" element={<PrivateRoute><Library /></PrivateRoute>} />
        <Route path="/doctors/:id" element={<PrivateRoute><DoctorPage /></PrivateRoute>} />
        <Route path="/search" element={<PrivateRoute><Search /></PrivateRoute>} />
        <Route path="/share" element={<PrivateRoute inDemo={false}><ShareLinks /></PrivateRoute>} />
        <Route path="/share-links/:id" element={<PrivateRoute inDemo={false}><ShareLinkDetail /></PrivateRoute>} />
        <Route path="/share-requests/:id" element={<PrivateRoute inDemo={false}><ShareRequestPage /></PrivateRoute>} />
        <Route path="/account" element={<PrivateRoute inDemo={false}><Account /></PrivateRoute>} />
      </Routes>
      </ChatProvider>
    </AuthContext.Provider>
  );
}
