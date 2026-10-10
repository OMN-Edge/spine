import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';

export default function Register() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== again) return setError('The two passwords do not match');
    try {
      setDone((await api.auth.register(email, password)).message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account');
    }
  };

  return (
    <AuthCard title="Create an account" footer={<p><Link to="/login" className="text-blue-600">Back to sign in</Link></p>}>
      {done ? (
        <Notice kind="ok">{done}</Notice>
      ) : (
        <form onSubmit={submit}>
          <input type="email" placeholder="Email" autoComplete="username" autoFocus
            value={email} onChange={e => setEmail(e.target.value)} className={inputClass} />
          <input type="password" placeholder="Password (at least 12 characters)" autoComplete="new-password"
            value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
          <input type="password" placeholder="Password again" autoComplete="new-password"
            value={again} onChange={e => setAgain(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className={buttonClass}>Create account</button>
        </form>
      )}
    </AuthCard>
  );
}
