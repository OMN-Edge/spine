import { useState, useEffect } from 'react';
import { Routes, Route, Link, useNavigate, Navigate } from 'react-router-dom';
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
import ReviewQueue from './pages/ReviewQueue';
import DocumentReview from './pages/DocumentReview';
import Search from './pages/Search';
import ShareLinks from './pages/ShareLinks';
import PublicShareView from './pages/PublicShareView';

function Layout({ children }: { children: React.ReactNode }) {
  const { email, setAuthenticated } = useAuth();
  const navigate = useNavigate();

  const logout = async () => {
    await api.auth.logout();
    setAuthenticated(false);
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6">
        <span className="font-semibold text-gray-900 text-lg mr-4">Spine</span>
        <Link to="/" className="text-sm text-gray-600 hover:text-gray-900">Timeline</Link>
        <Link to="/upload" className="text-sm text-gray-600 hover:text-gray-900">Upload</Link>
        <Link to="/review" className="text-sm text-gray-600 hover:text-gray-900">Review</Link>
        <Link to="/search" className="text-sm text-gray-600 hover:text-gray-900">Search</Link>
        <Link to="/share" className="text-sm text-gray-600 hover:text-gray-900">Share Links</Link>
        <Link to="/account" className="ml-auto text-sm text-gray-400 hover:text-gray-600">{email}</Link>
        <button onClick={logout} className="text-sm text-gray-400 hover:text-gray-600">Sign out</button>
      </nav>
      <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
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
        <Route path="/review" element={<PrivateRoute><ReviewQueue /></PrivateRoute>} />
        <Route path="/review/:id" element={<PrivateRoute><DocumentReview /></PrivateRoute>} />
        <Route path="/search" element={<PrivateRoute><Search /></PrivateRoute>} />
        <Route path="/share" element={<PrivateRoute><ShareLinks /></PrivateRoute>} />
        <Route path="/account" element={<PrivateRoute><Account /></PrivateRoute>} />
      </Routes>
    </AuthContext.Provider>
  );
}
