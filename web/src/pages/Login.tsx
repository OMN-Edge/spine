import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';

export default function Login() {
  const { setAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState('');
  const [options, setOptions] = useState({ registration: 'operator', recovery: false });

  useEffect(() => {
    api.auth.options().then(setOptions).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setUnverified(false);
    setResent('');
    try {
      const result = await api.auth.login(email, password);
      setAuthenticated(true, result.email);
      navigate('/');
    } catch (err) {
      // The server's own words: "incorrect email or password", a rate-limit
      // notice, or that the address is not confirmed yet. It deliberately does
      // not say which half of a wrong login was wrong.
      setUnverified(err instanceof ApiError && err.code === 'email_not_verified');
      setError(err instanceof Error ? err.message : 'Could not sign in');
    }
  };

  const resend = async () => {
    try {
      setResent((await api.auth.resendVerification(email)).message);
    } catch (err) {
      setResent(err instanceof Error ? err.message : 'Could not send the link');
    }
  };

  return (
    <AuthCard
      title="Spine"
      footer={
        <>
          {options.recovery && <p><Link to="/forgot" className="text-blue-600">Forgot your password?</Link></p>}
          {options.registration === 'open' && <p>No account? <Link to="/register" className="text-blue-600">Create one</Link></p>}
        </>
      }
    >
      <form onSubmit={submit}>
        <input
          type="email" placeholder="Email" autoComplete="username" autoFocus
          value={email} onChange={e => setEmail(e.target.value)} className={inputClass}
        />
        <input
          type="password" placeholder="Password" autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)} className={inputClass}
        />
        {error && <Notice kind="error">{error}</Notice>}
        {unverified && (
          <p className="text-sm mb-3">
            <button type="button" onClick={resend} className="text-blue-600 underline">
              Send the confirmation link again
            </button>
          </p>
        )}
        {resent && <Notice kind="ok">{resent}</Notice>}
        <button type="submit" className={buttonClass}>Sign in</button>
      </form>
    </AuthCard>
  );
}
