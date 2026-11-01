import { useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { Actions, PublicPage, Section, TextLink, usePublicOptions } from '../components/PublicPage';
import { EmergencyCardDrawing, FamilySpines, ReadingDrawing, SealingDrawing, WhoCanSee } from '../components/PublicDrawings';

/**
 * What a signed-out visitor sees at `/`: what Spine does with their own records, how they are protected and who can see what, before they
 * are asked for anything, and then what it does for the people they look after. The first step it offers is the demo, which needs no
 * account. Every claim here is one SECURITY.md or the README makes (M-34 to M-38 for the sealing, M-35 for the relay, M-36 for shares, M-47
 * for the card, M-48 to M-51 for the people an account looks after); change one only together with the document it comes from.
 */
export default function Landing() {
  const { t } = useI18n();
  const options = usePublicOptions();
  const open = options.registration !== 'operator';

  return (
    <PublicPage options={options}>
      <section>
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-14 pt-12 sm:px-6 sm:pt-16 lg:grid-cols-[1fr_1.05fr]">
          <div>
            <h1 className="max-w-xl font-display text-[clamp(2.4rem,5vw,3.7rem)] font-normal leading-[1.06] tracking-[-0.015em]">
              {t('All your medical records, in one place only you can open.')}
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink/75">
              {t('Spine keeps your scans, results and letters, reads out the dates, values and doctors in them, and lets you show a doctor exactly what you choose, for as long as you choose.')}
            </p>
            <Actions options={options} className="mt-9" />
            {options.waitlist && !open && <Waitlist />}
            {options.instance === 'private' && <p className="mt-4 text-sm text-ink/60">{t('This is a private Spine. Accounts are approved by its administrator.')}</p>}
          </div>
          <figure>
            <ReadingDrawing />
            <figcaption className="mt-2 text-sm text-ink/60">{t('Each value links to the page it was read from')}</figcaption>
          </figure>
        </div>
      </section>

      <section className="border-t border-ink/10">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className={H2}>{t('From a folder of papers to records you can find, check and share')}</h2>
          <ol className="mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
            <Step n={1} title={t('Add what you have')}>
              {t('Upload PDFs and Word files, or photograph paper with your phone. A file that holds several documents is split into them, and you check the split.')}
            </Step>
            <Step n={2} title={t('Check what was read')}>
              {t('Every date, value and doctor links back to the page it came from. Anything uncertain is marked for you to check, and what you correct stays corrected.')}
            </Step>
            <Step n={3} title={t('Share what a doctor needs')}>
              {t('Send a link to the documents you choose. The doctor needs no account, and the link ends when you say, or sooner if you end it.')}
            </Step>
          </ol>
          <p className="mt-10"><TextLink to="/how-it-works">{t('Everything Spine does')}</TextLink></p>
        </div>
      </section>

      <section id="protection" className="scroll-mt-4 border-t border-ink/10">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className={H2}>{t('Built so that only you can read your records')}</h2>
          <div className="mt-10"><SealingDrawing /></div>
          <dl className="mt-14 grid gap-x-12 gap-y-8 border-t border-ink/10 pt-10 md:grid-cols-2">
            <Point title={t('Sealed on your device')}>{t('Your records are read, searched and kept in your browser. The keys that open them are made there, from your password. The server stores them only as sealed pieces it cannot open.')}</Point>
            <Point title={t('You decide what a doctor sees')}>{t('A share link covers what you pick: everything, a tag, a few documents or a date range. It ends when you say, you can revoke it at any time, and the server never holds a key that opens it.')}</Point>
            <Point title={t('AI you can check')}>{t('Every value it reads links back to the page it came from. Anything it is unsure of is marked for you to check, and what you correct stays corrected.')}</Point>
            <Point title={t('Careful with what leaves')}>{t('To read and sort documents, their text is sent to an AI model through a relay that does not store or log it. Images of your pages are sent only where image reading has been switched on.')}</Point>
          </dl>
          <p className="mt-10"><TextLink to="/protection">{t('How your records are protected, in full')}</TextLink></p>
        </div>
      </section>

      <section className="bg-band text-band-fg">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className={H2}>{t('Who can see what')}</h2>
          <p className="mt-3 text-lg text-band-fg/75">{t('Plainly, with nothing left out.')}</p>
          <div className="mt-10"><WhoCanSee /></div>
        </div>
      </section>

      <section className="bg-honey/[0.09]">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_1fr]">
          <div>
            <h2 className={H2}>{t('Records for the people you look after')}</h2>
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink/70">{t('A child’s records, or an ageing parent’s, kept apart from your own, each with a key of its own.')}</p>
            <ul className="mt-6 space-y-4">
              <Bullet>{t('Let the other parent in, as someone who can change the records, or let someone only read them.')}</Bullet>
              <Bullet>{t('From sixteen, a child can have an account of their own, at your invitation.')}</Bullet>
              <Bullet>{t('At eighteen, they can take their records into their own account, and decide who keeps seeing them.')}</Bullet>
            </ul>
            <p className="mt-8"><TextLink to="/families">{t('Spine for families')}</TextLink></p>
          </div>
          <figure>
            <FamilySpines />
            <figcaption className="mt-2 text-sm text-ink/60">{t('Each document is a vertebra on one person’s spine, and each person’s records are kept apart.')}</figcaption>
          </figure>
        </div>
      </section>

      <section className="border-t border-ink/10">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1fr_auto]">
          <div className="max-w-2xl">
            <h2 className={H2}>{t('A card for when you cannot speak for yourself')}</h2>
            <p className="mt-4 text-lg leading-relaxed text-ink/70">
              {t('Write down allergies, medicines and who to call, and print it the size of a bank card. Anyone who scans its code can read it, with no account, and you are told when it is opened. Each person you look after can have one.')}
            </p>
          </div>
          <EmergencyCardDrawing />
        </div>
      </section>

      <Section title={t('What Spine is, and what it is not')}>
        <p className="leading-relaxed text-ink/80">
          {t('Spine helps you keep, read and share your records. It does not diagnose and does not give medical advice. Its AI reads your documents and can be wrong, which is why every value shows where it came from and you can correct it.')}
        </p>
        <p className="mt-6"><TextLink to="/purpose">{t('What Spine is for')}</TextLink></p>
      </Section>

      <section className="border-t border-ink/10">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-4 py-16 sm:px-6 lg:flex-row lg:items-end">
          <h2 className="max-w-xl font-display text-[clamp(2rem,4.2vw,3.2rem)] font-normal leading-[1.08]">{t('Start with your own records.')}</h2>
          <Actions options={options} />
        </div>
      </section>
    </PublicPage>
  );
}

const H2 = 'max-w-3xl font-display text-[clamp(1.7rem,3.2vw,2.4rem)] font-normal leading-tight';

/** Asking to be told when Spine opens, while accounts cannot yet be made. An address and the day are kept, for that and nothing else. */
function Waitlist() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'failed'>('idle');
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('sending');
    try { await api.waitlist(email, new URLSearchParams(window.location.search).get('ref') ?? undefined); setState('done'); } catch { setState('failed'); }
  };
  if (state === 'done') return <p className="mt-6 text-sm text-ink/70">{t('Thank you. We will write once, when Spine opens.')}</p>;
  return (
    <form onSubmit={e => void send(e)} className="mt-6 max-w-md">
      <label className="block text-sm font-medium" htmlFor="waitlist-email">{t('Tell me when Spine opens')}</label>
      <div className="mt-2 flex gap-2">
        <input id="waitlist-email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className="min-w-0 flex-1 rounded-full border border-ink/25 bg-transparent px-4 py-2" />
        <button type="submit" disabled={state === 'sending'} className="rounded-full bg-ink px-5 py-2 font-medium text-paper hover:bg-ink/85 disabled:opacity-50">{t('Notify me')}</button>
      </div>
      <p className="mt-2 text-xs text-ink/60">{t('We keep your address only to write to you when Spine opens. Ask us and we remove it.')}</p>
      {state === 'failed' && <p role="alert" className="mt-2 text-sm text-red-700">{t('That address could not be saved. Check it and try again.')}</p>}
    </form>
  );
}

/** One step of the three a person takes, in order: the numbers are the order. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li>
      <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-full border border-accent/40 font-display text-lg text-accent">{n}</span>
      <h3 className="mt-4 text-lg font-medium">{title}</h3>
      <p className="mt-2 leading-relaxed text-ink/70">{children}</p>
    </li>
  );
}

/** One of the four ways records are protected: a short title and what it means. */
function Point({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-lg font-medium">{title}</dt>
      <dd className="mt-2 leading-relaxed text-ink/70">{children}</dd>
    </div>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3 leading-relaxed text-ink/80">
      <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </li>
  );
}
