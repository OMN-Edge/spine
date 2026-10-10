import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      setDone((await api.auth.forgot(email)).message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link');
    }
  };

  return (
    <AuthCard title="Reset your password" footer={<p><Link to="/login" className="text-blue-600">Back to sign in</Link></p>}>
      {done ? (
        <Notice kind="ok">{done}</Notice>
      ) : (
        <form onSubmit={submit}>
          <input type="email" placeholder="Email" autoComplete="username" autoFocus
            value={email} onChange={e => setEmail(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className={buttonClass}>Send a link</button>
        </form>
      )}
    </AuthCard>
  );
}
