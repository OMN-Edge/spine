import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { buttonClass, inputClass, Notice } from '../components/AuthCard';
import TwoFactor from '../components/TwoFactor';

export default function Account() {
  const { email } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setDone(false);
    if (next !== again) return setError('The two new passwords do not match');
    try {
      await api.auth.changePassword(current, next);
      setDone(true);
      setCurrent(''); setNext(''); setAgain('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    }
  };

  return (
    <div className="max-w-md mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">Account</h1>
      <p className="text-sm text-gray-500 mb-6">{email}</p>

      <form onSubmit={submit} className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="font-medium text-gray-900 mb-4">Change password</h2>
        <input type="password" placeholder="Current password" autoComplete="current-password"
          value={current} onChange={e => setCurrent(e.target.value)} className={inputClass} />
        <input type="password" placeholder="New password (at least 12 characters)" autoComplete="new-password"
          value={next} onChange={e => setNext(e.target.value)} className={inputClass} />
        <input type="password" placeholder="New password again" autoComplete="new-password"
          value={again} onChange={e => setAgain(e.target.value)} className={inputClass} />
        {error && <Notice kind="error">{error}</Notice>}
        {done && <Notice kind="ok">Password changed. Your other sessions have been signed out.</Notice>}
        <button type="submit" className={buttonClass}>Change password</button>
      </form>

      <TwoFactor />
    </div>
  );
}
