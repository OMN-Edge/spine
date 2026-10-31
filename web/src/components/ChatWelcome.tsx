import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HELP_TOPICS, START_TOPICS, helpTopic } from 'spine-core/help';
import { api } from '../api';
import { announceChange } from '../dataChanged';
import { useGuide } from '../guide';
import { useI18n } from '../i18n';

const chip = 'rounded-full border border-gray-200 px-3 py-1.5 text-left text-xs text-gray-600 transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50';

/**
 * What an empty conversation shows. To someone who has not added anything yet: a welcome, with the first steps as buttons and the
 * questions about how Spine works. To everyone else: questions about their records, and the same questions about Spine underneath.
 * None of it calls a model: the answers about Spine are fixed text (core's help.ts), written into the conversation when asked for.
 */
export function ChatWelcome({ suggestions, onAsk, onHelp, onLeave, busy }: {
  suggestions: string[];
  onAsk: (question: string) => void;
  onHelp: (topic: string) => void;
  /** The person went somewhere from here: on a phone the panel covers the page, so it closes. */
  onLeave: () => void;
  busy: boolean;
}) {
  const { t, lang } = useI18n();
  const guide = useGuide();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const greeting = !!guide?.state && !guide.isDone('welcome') && guide.state.progress.uploads === 0;
  const finish = () => guide?.done('welcome');

  const samples = async () => {
    setLoading(true); setError('');
    try {
      const state = await api.demo.state();
      if (!state.loaded) await api.demo.load(lang === 'ro' ? 'ro' : 'en');
      announceChange();
      finish();
      navigate('/');
      onLeave();
    } catch {
      setError(t('The sample records could not be added. Try again.'));
    }
    setLoading(false);
  };

  const topics = (
    <div className="flex flex-wrap gap-2">
      {HELP_TOPICS.filter(topic => START_TOPICS.includes(topic.id)).map(topic => (
        <button key={topic.id} type="button" disabled={busy} onClick={() => { finish(); onHelp(topic.id); }} className={chip}>{t(topic.question)}</button>
      ))}
    </div>
  );

  if (greeting) {
    return (
      <div className="space-y-4">
        <div className="space-y-2 text-sm text-gray-900">
          <p className="font-medium">{t('Welcome to Spine')}</p>
          <p>{t('Spine keeps your medical documents in one place, reads them for you, and lets you share them with a doctor when you choose.')}</p>
          <p>{t('Where would you like to start?')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { finish(); navigate('/upload'); onLeave(); }} className="rounded-full bg-brand-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700">{t('Add a document')}</button>
          <button type="button" onClick={() => void samples()} disabled={loading} className="rounded-full border border-brand-200 bg-brand-50 px-3.5 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-50">{loading ? t('Setting up…') : t('Look around with sample records')}</button>
        </div>
        {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
        <p className="pt-1 text-xs text-gray-500">{t('Or ask how it works:')}</p>
        {topics}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {suggestions.map(q => <button key={q} type="button" disabled={busy} onClick={() => onAsk(q)} className={chip}>{q}</button>)}
      </div>
      <p className="text-xs text-gray-500">{t('How Spine works:')}</p>
      {topics}
    </div>
  );
}

/** A question about Spine as the person asked it, or its fixed answer, in their language. */
export function HelpMessage({ topic, role }: { topic: string; role: 'user' | 'assistant' }) {
  const { t } = useI18n();
  const found = helpTopic(topic);
  if (!found) return null;
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-50 px-3.5 py-2 text-sm text-gray-900">{t(found.question)}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm text-gray-900">
      {found.paragraphs.map(p => <p key={p}>{t(p)}</p>)}
      <p className="text-xs text-gray-400">{t('From Spine’s own help, not written by the AI model.')}</p>
    </div>
  );
}
