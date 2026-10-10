import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { takeTokenFromUrl } from '../auth';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';

export default function Reset() {
  // Read once, on first render. StrictMode renders twice, but the second read would
  // find the fragment already removed, so keep the first.
  const token = useRef<string | null>(null);
  if (token.current === null) token.current = takeTokenFromUrl();

  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== again) return setError('The two passwords do not match');
    try {
      await api.auth.reset(token.current ?? '', password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password');
    }
  };

  return (
    <AuthCard title="Choose a new password" footer={<p><Link to="/login" className="text-blue-600">Go to sign in</Link></p>}>
      {done ? (
        <Notice kind="ok">Your password is changed. You have been signed out everywhere; sign in with the new one.</Notice>
      ) : !token.current ? (
        <Notice kind="error">This link is incomplete. Use the link from the email in full.</Notice>
      ) : (
        <form onSubmit={submit}>
          <input type="password" placeholder="New password (at least 12 characters)" autoComplete="new-password" autoFocus
            value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
          <input type="password" placeholder="New password again" autoComplete="new-password"
            value={again} onChange={e => setAgain(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className={buttonClass}>Change password</button>
        </form>
      )}
    </AuthCard>
  );
}
