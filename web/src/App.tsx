import { useState, useEffect } from 'react';
import { Routes, Route, Link, NavLink, useNavigate, useLocation, useParams, Navigate } from 'react-router-dom';
import { api } from './api';
import { AuthContext, useAuth } from './auth';
import Login from './pages/Login';
import Register from './pages/Register';
import Verify from './pages/Verify';
import Forgot from './pages/Forgot';
import Reset from './pages/Reset';
import Account from './pages/Account';
import Timeline from './pages/Timeline';
import Upload from './pages/Upload';
import UploadPages from './pages/UploadPages';
import ReviewQueue from './pages/ReviewQueue';
import DocumentPage from './pages/DocumentPage';
import Search from './pages/Search';
import Trends from './pages/Trends';
import Doctors from './pages/Doctors';
import DoctorPage from './pages/DoctorPage';
import ShareLinks from './pages/ShareLinks';
import PublicShareView from './pages/PublicShareView';
import { Wordmark } from './components/Logo';

const NAV_LINKS = [
  { to: '/', label: 'Timeline' },
  { to: '/upload', label: 'Upload' },
  { to: '/review', label: 'Review' },
  { to: '/trends', label: 'Trends' },
  { to: '/doctors', label: 'Doctors' },
  { to: '/search', label: 'Search' },
  { to: '/share', label: 'Share Links' },
];

function Layout({ children }: { children: React.ReactNode }) {
  const { email, setAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // A link was followed: the menu has done its job.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const logout = async () => {
    await api.auth.logout();
    setAuthenticated(false);
    navigate('/login');
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm ${isActive ? 'text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900'}`;

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 py-3 flex items-center gap-6">
          <Link to="/" className="mr-2 md:mr-4" aria-label="Spine, home"><Wordmark /></Link>

          {/* wide screens: everything in one row */}
          <div className="hidden md:flex items-center gap-6 flex-1">
            {NAV_LINKS.map(link => (
              <NavLink key={link.to} to={link.to} end={link.to === '/'} className={linkClass}>{link.label}</NavLink>
            ))}
            <Link to="/account" className="ml-auto text-sm text-gray-400 hover:text-gray-600 truncate max-w-[16rem]">{email}</Link>
            <button onClick={logout} className="text-sm text-gray-400 hover:text-gray-600">Sign out</button>
          </div>

          {/* narrow screens: a menu button */}
          <button
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            aria-expanded={menuOpen}
            aria-controls="nav-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className="md:hidden ml-auto -mr-2 p-2 rounded-lg text-gray-600 hover:bg-gray-100"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>

        {menuOpen && (
          <div id="nav-menu" className="md:hidden border-t border-gray-100 px-4 pb-3">
            {NAV_LINKS.map(link => (
              <NavLink
                key={link.to} to={link.to} end={link.to === '/'}
                className={({ isActive }) => `block py-3 text-base border-b border-gray-100 ${isActive ? 'text-gray-900 font-medium' : 'text-gray-600'}`}
              >
                {link.label}
              </NavLink>
            ))}
            <Link to="/account" className="block py-3 text-base text-gray-600 border-b border-gray-100 truncate">
              Account <span className="text-gray-400">· {email}</span>
            </Link>
            <button onClick={logout} className="block w-full text-left py-3 text-base text-gray-600">Sign out</button>
          </div>
        )}
      </nav>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</main>
    </div>
  );
}

/** The document page used to live under /review; old links and bookmarks still arrive. */
function ReviewRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/documents/${id}`} replace />;
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { authenticated } = useAuth();
  return authenticated ? <Layout>{children}</Layout> : <Navigate to="/login" replace />;
}

export default function App() {
  const [authenticated, setAuthenticatedState] = useState(false);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);

  const setAuthenticated = (value: boolean, who = '') => {
    setAuthenticatedState(value);
    setEmail(value ? who : '');
  };

  useEffect(() => {
    api.auth.me()
      .then(r => setAuthenticated(r.authenticated, r.email))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;

  return (
    <AuthContext.Provider value={{ authenticated, email, setAuthenticated }}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/share/:token" element={<PublicShareView />} />
        <Route path="/" element={<PrivateRoute><Timeline /></PrivateRoute>} />
        <Route path="/upload" element={<PrivateRoute><Upload /></PrivateRoute>} />
        <Route path="/uploads/:id" element={<PrivateRoute><UploadPages /></PrivateRoute>} />
        <Route path="/review" element={<PrivateRoute><ReviewQueue /></PrivateRoute>} />
        <Route path="/documents/:id" element={<PrivateRoute><DocumentPage /></PrivateRoute>} />
        <Route path="/review/:id" element={<ReviewRedirect />} />
        <Route path="/trends" element={<PrivateRoute><Trends /></PrivateRoute>} />
        <Route path="/doctors" element={<PrivateRoute><Doctors /></PrivateRoute>} />
        <Route path="/doctors/:id" element={<PrivateRoute><DoctorPage /></PrivateRoute>} />
        <Route path="/search" element={<PrivateRoute><Search /></PrivateRoute>} />
        <Route path="/share" element={<PrivateRoute><ShareLinks /></PrivateRoute>} />
        <Route path="/account" element={<PrivateRoute><Account /></PrivateRoute>} />
      </Routes>
    </AuthContext.Provider>
  );
}
