import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { GuideKey } from '../api';
import { useGuide } from '../guide';
import { useI18n } from '../i18n';
import { useChat } from './ChatProvider';

/**
 * A tip shown the first time something happens (an upload waits for its grouping, documents have been read, a link has been made, results,
 * doctors or a suggested connection are read), until the person puts it away. One key can be shown in more than one place (results on a
 * document and on Trends), and "Got it" in either puts both away. "Tell me more" opens the fixed answer about it in the chat. Nothing in
 * the demo, which keeps nothing.
 */
export default function GuideTip({ tip, topic, className = 'mb-4', children }: { tip: GuideKey; topic?: string; className?: string; children: React.ReactNode }) {
  const { t } = useI18n();
  const guide = useGuide();
  const chat = useChat();
  const showing = !!guide?.state && !guide.isDone(tip);
  useEffect(() => { if (showing) guide?.shown(tip); }, [showing, tip]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!showing) return null;
  return (
    <div role="note" className={`${className} flex gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900`}>
      <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.9V16h5v-.2c0-.8.4-1.5 1-1.9A6 6 0 0 0 12 3z" />
      </svg>
      <div className="min-w-0 flex-1">
        <div>{children}</div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
          <button type="button" onClick={() => guide?.done(tip)} className="text-brand-700 hover:underline">{t('Got it')}</button>
          {topic && chat?.enabled && (
            <button type="button" onClick={() => { chat.startNew(); chat.setOpen(true); void chat.help(topic, { fresh: true }); }} className="text-brand-700 hover:underline">{t('Tell me more')}</button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The first steps, on the timeline, ticked off from the person's own records (sample records do not count) until all are done or the
 * list is put away.
 */
export function GetStarted() {
  const { t } = useI18n();
  const guide = useGuide();
  const progress = guide?.state?.progress;
  const steps = progress ? [
    { done: progress.uploads > 0, label: t('Add your first document'), to: '/upload', action: t('Add') },
    // An upload still waiting for its grouping has nothing in the review queue yet, so the step leads there first.
    { done: progress.reviewed > 0, label: t('Review what was read from it'), to: progress.grouping_waiting > 0 ? '/upload' : '/review', action: t('Review') },
    { done: progress.shares > 0, label: t('Share it with a doctor, when you need to'), to: '/share', action: t('Share') },
  ] : [];
  const all = steps.length > 0 && steps.every(s => s.done);
  const showing = !!progress && !guide?.isDone('checklist') && !all;
  useEffect(() => { if (all && !guide?.isDone('checklist')) guide?.done('checklist'); }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (showing) guide?.shown('checklist'); }, [showing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!showing) return null;
  const next = steps.findIndex(s => !s.done);
  return (
    <section aria-label={t('Get started')} className="mb-6 rounded-xl border border-gray-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-gray-900">{t('Get started')}</h2>
        <button type="button" onClick={() => guide?.done('checklist')} className="text-xs text-gray-400 hover:text-gray-700 hover:underline">{t('Hide')}</button>
      </div>
      <ol className="mt-2 space-y-1.5">
        {steps.map((step, i) => (
          <li key={step.label} className="flex items-center gap-2.5 text-sm">
            <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${step.done ? 'bg-emerald-500 text-white' : i === next ? 'border-2 border-brand-500 text-brand-600' : 'border border-gray-300 text-gray-400'}`}>
              {step.done ? '✓' : i + 1}
            </span>
            <span className={`min-w-0 flex-1 ${step.done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
              {step.label}<span className="sr-only">{step.done ? ` (${t('done')})` : ''}</span>
            </span>
            {!step.done && i === next && <Link to={step.to} className="shrink-0 text-xs font-medium text-brand-600 hover:underline">{step.action} →</Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}
