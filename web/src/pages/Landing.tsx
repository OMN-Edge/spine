import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { api } from '../api';
import { useAuth } from '../auth';
import { LogoMark } from '../components/Logo';
import { LanguageSwitcher, useI18n } from '../i18n';

/**
 * What a signed-out visitor sees at `/`: what Spine does, and who can see what, before they are asked for a password.
 * Every claim here is one SECURITY.md or the README makes (M-34 to M-38 for the sealing, M-35 for the relay, M-36
 * for shares, the purpose text for what Spine is not); change one only together with the document it comes from.
 * The drawings show how it works rather than decorate: a page whose values point to what was read from them
 * (grounding), and a record sealed on the device before the server keeps it. The record in them is invented.
 * The fonts are bundled (the policy allows fonts from this origin only) and used on this page alone.
 */
export default function Landing() {
  const { t } = useI18n();
  const [registration, setRegistration] = useState<'operator' | 'open'>('operator');

  useEffect(() => {
    api.auth.options().then(o => setRegistration(o.registration)).catch(() => {});
  }, []);

  const open = registration === 'open';

  return (
    <div className="min-h-screen bg-paper text-ink antialiased">
      <header className="border-b border-ink/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <span className="inline-flex items-center gap-2">
            <LogoMark className="h-7 w-7 text-ink" />
            <span className="text-lg font-semibold tracking-tight">Spine</span>
          </span>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Link to="/login" className="rounded-full border border-ink/20 px-4 py-1.5 text-sm font-medium hover:bg-ink/5">{t('Sign in')}</Link>
          </div>
        </div>
      </header>

      <main>
        <section className="landing-grid">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-14 sm:px-6 sm:pt-20 lg:grid-cols-[1fr_1.05fr] lg:pb-24">
            <div>
              <Eyebrow>{t('Your health documents, kept private')}</Eyebrow>
              <h1 className="text-[clamp(2.4rem,4.4vw,3.3rem)] font-light leading-[1.05] tracking-[-0.025em]">
                {t('All your medical records, in one place only you can open.')}
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink/70">
                {t('Spine keeps your scans, results and letters, reads out the dates, values and doctors in them, and lets you show a doctor exactly what you choose, for as long as you choose.')}
              </p>
              <Actions open={open} className="mt-9" />
              <p className="mt-5 text-sm">
                <a href="#protection" className="text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent">{t('How your records are protected')}</a>
              </p>
            </div>
            <figure>
              <ReadingDrawing />
              <figcaption className="mt-3 font-label text-xs uppercase tracking-wider text-ink/50">
                {t('Each value links to the page it was read from')}
              </figcaption>
            </figure>
          </div>
        </section>

        <section id="protection" className="scroll-mt-4 border-t border-ink/10">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <Eyebrow n="01">{t('Protection')}</Eyebrow>
            <h2 className={h2}>{t('Built so that only you can read your records')}</h2>
            <SealingDrawing />
            <div className="mt-16 grid gap-px overflow-hidden rounded-2xl border border-ink/10 bg-ink/10 sm:grid-cols-2">
              <Pillar label={t('Sealed')} title={t('Sealed on your device')}>
                {t('Your records are read, searched and kept in your browser. The keys that open them are made there, from your password. The server stores them only as sealed pieces it cannot open.')}
              </Pillar>
              <Pillar label={t('Shared')} title={t('You decide what a doctor sees')}>
                {t('A share link covers what you pick: everything, a tag, a few documents or a date range. It ends when you say, you can revoke it at any time, and the server never holds a key that opens it.')}
              </Pillar>
              <Pillar label={t('Checked')} title={t('AI you can check')}>
                {t('Every value it reads links back to the page it came from. Anything it is unsure of is marked for you to check, and what you correct stays corrected.')}
              </Pillar>
              <Pillar label={t('Sent')} title={t('Careful with what leaves')}>
                {t('To read and sort documents, their text is sent to an AI model through a relay that does not store or log it. Images of your pages are sent only where image reading has been switched on.')}
              </Pillar>
            </div>
          </div>
        </section>

        <section className="bg-ink text-paper">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <Eyebrow n="02" dark>{t('Visibility')}</Eyebrow>
            <h2 className={h2}>{t('Who can see what')}</h2>
            <p className="mt-3 text-lg text-paper/70">{t('Plainly, with nothing left out.')}</p>
            <dl className="mt-10 border-t border-paper/15">
              <Who who={t('You')}>{t('Everything, on your own device, once you have unlocked it.')}</Who>
              <Who who={t('A doctor you share with')}>{t('Only what the link shares, until it ends. No account or app needed.')}</Who>
              <Who who={t('The AI relay')}>{t('The text of a request while it is answered. It does not store or log it.')}</Who>
              <Who who={t('The server')}>{t("Your email, the size and time of each sealed save, and your share links' dates and where they were opened. Not what your records say.")}</Who>
            </dl>
          </div>
        </section>

        <section>
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <Eyebrow n="03">{t('Features')}</Eyebrow>
            <h2 className={h2}>{t('What Spine does for you')}</h2>
            <div className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              <Feature title={t('Upload or scan')}>{t("PDFs and Word files, or pages photographed with your phone's camera.")}</Feature>
              <Feature title={t('Sorted for you')}>{t('A long file of many documents is split into its documents, each with its date, doctor and type.')}</Feature>
              <Feature title={t('Results over time')}>{t('Each test is charted across your documents, against the range printed on them.')}</Feature>
              <Feature title={t('Search and ask')}>{t('Find any word on any page, or ask a question about your records in plain language.')}</Feature>
              <Feature title={t('In your language')}>{t("Read a document's details in English, Romanian, French or German.")}</Feature>
              <Feature title={t('Yours to take')}>{t('Export one document or everything as a file you can restore anywhere.')}</Feature>
            </div>
          </div>
        </section>

        <section className="border-t border-ink/10">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <Eyebrow n="04">{t('Limits')}</Eyebrow>
            <h2 className={h2}>{t('What Spine is not')}</h2>
            <div className="mt-10 grid gap-6 lg:grid-cols-2">
              <p className="rounded-2xl border border-amber-300/70 bg-amber-50 p-6 text-lg leading-relaxed text-amber-950">
                {t('Spine is not a medical device. It does not diagnose, does not tell you whether a result is good or bad, and is not for emergencies. Ask your doctor what your records mean.')}
              </p>
              <p className="rounded-2xl border border-ink/10 bg-white p-6 text-lg leading-relaxed text-ink/80">
                {t('Its security has not yet been independently audited. Its security document states what is protected, how, and the gaps still open.')}
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-ink/10">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-4 py-20 sm:px-6 lg:flex-row lg:items-end">
            <h2 className="text-[clamp(2.2rem,4.4vw,3.6rem)] font-light leading-[1.05] tracking-[-0.025em]">{t('Start with your own records.')}</h2>
            <Actions open={open} />
          </div>
        </section>
      </main>

      <footer className="border-t border-ink/10">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-ink/60 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span className="inline-flex items-center gap-2">
            <LogoMark className="h-5 w-5 text-ink/70" /> {t('Open-source software, licensed under the AGPL-3.0.')}
          </span>
          <nav className="flex flex-wrap gap-x-5 gap-y-2">
            <Link to="/privacy" className="hover:text-ink hover:underline">{t('Privacy notice')}</Link>
            <Link to="/terms" className="hover:text-ink hover:underline">{t('Terms of use')}</Link>
            <Link to="/purpose" className="hover:text-ink hover:underline">{t('What Spine is for')}</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

const h2 = 'max-w-3xl text-[clamp(1.9rem,3.6vw,2.9rem)] font-light leading-tight tracking-[-0.02em]';
const MONO = "'IBM Plex Mono', ui-monospace, monospace";
const INK = 'rgb(var(--ink))';
const FAINT = 'rgb(var(--ink) / 0.14)';
const ACCENT = 'rgb(var(--accent))';

/** Signing up or in, and the demo: the app itself with invented records, in this browser only, with no account. */
function Actions({ open, className = '' }: { open: boolean; className?: string }) {
  const { t, lang } = useI18n();
  const { startDemo } = useAuth();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const solid = 'rounded-full bg-ink px-6 py-3 font-medium text-paper hover:bg-ink/85';
  const outline = 'rounded-full border border-ink/25 px-6 py-3 font-medium text-ink hover:bg-ink/5 disabled:opacity-50';
  const tryDemo = async () => {
    setStarting(true); setFailed(false);
    try { await startDemo(lang === 'ro' ? 'ro' : 'en'); navigate('/'); } catch (err) { console.warn('the demo could not start:', (err as Error)?.message); setFailed(true); }
    setStarting(false);
  };
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-3">
        {open && <Link to="/register" className={solid}>{t('Create an account')}</Link>}
        <Link to="/login" className={open ? outline : solid}>{t('Sign in')}</Link>
        <button type="button" onClick={() => void tryDemo()} disabled={starting} className={outline}>{starting ? t('Opening…') : t('Try the demo')}</button>
      </div>
      <p className="mt-3 text-sm text-ink/60">{t('The demo opens the app with invented records, in this browser only: no account, and nothing is saved.')}</p>
      {failed && <p role="alert" className="mt-2 text-sm text-red-700">{t('The demo could not start in this browser. Try again, or another browser.')}</p>}
    </div>
  );
}

/** The small monospaced label over a section, numbered like the parts of a document. */
function Eyebrow({ n, dark = false, children }: { n?: string; dark?: boolean; children: ReactNode }) {
  return (
    <p className={`mb-5 flex items-center gap-2 font-label text-xs font-medium uppercase tracking-[0.14em] ${dark ? 'text-accent-light' : 'text-accent'}`}>
      <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {n && <span className={dark ? 'text-paper/50' : 'text-ink/40'}>{n}</span>}
      {children}
    </p>
  );
}

function Pillar({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <div className="bg-paper p-7 sm:p-8">
      <p className="font-label text-xs font-medium uppercase tracking-[0.14em] text-accent">{label}</p>
      <h3 className="mt-3 text-xl font-medium tracking-tight">{title}</h3>
      <p className="mt-2 leading-relaxed text-ink/70">{children}</p>
    </div>
  );
}

function Who({ who, children }: { who: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-paper/15 py-5 sm:grid-cols-[16rem_1fr] sm:gap-8">
      <dt className="font-label text-sm uppercase tracking-[0.1em] text-accent-light">{who}</dt>
      <dd className="text-lg leading-relaxed text-paper/90">{children}</dd>
    </div>
  );
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-ink/15 pt-5">
      <h3 className="text-lg font-medium tracking-tight">{title}</h3>
      <p className="mt-1.5 leading-relaxed text-ink/70">{children}</p>
    </div>
  );
}

function Lock({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <rect x="-11" y="-2" width="22" height="17" rx="3.5" fill={ACCENT} />
      <path d="M-6 -2v-4a6 6 0 0 1 12 0v4" fill="none" stroke={ACCENT} strokeWidth="2.2" />
    </g>
  );
}

/**
 * A lab report drawn in lines, three of its values boxed, each joined to the value read from it: the grounding
 * every extracted field has. The lines draw themselves once (not for a reader who asks for less motion).
 */
function ReadingDrawing() {
  const { t } = useI18n();
  // The report's rows: the value printed, the width of its label, and which result (if any) was read from it.
  const rows: Array<{ value: string; label: number; read?: number }> = [
    { value: '13.8', label: 92, read: 0 }, { value: '4.61', label: 70 }, { value: '18', label: 84, read: 1 },
    { value: '412', label: 100, read: 2 }, { value: '7.2', label: 64 },
  ];
  const rowY = (i: number) => 172 + i * 34;
  const results = [
    { name: t('Haemoglobin'), value: '13.8 g/dL', y: 206 },
    { name: t('Ferritin'), value: '18 ng/mL', y: 262, low: true },
    { name: t('Vitamin B12'), value: '412 pg/mL', y: 318 },
  ];
  return (
    <svg viewBox="0 0 560 440" className="h-auto w-full" aria-hidden="true">
      {/* the page */}
      <rect x="18" y="18" width="286" height="404" rx="6" fill="#fff" stroke={INK} strokeWidth="1.25" />
      <rect x="40" y="42" width="26" height="26" rx="5" fill="none" stroke={INK} strokeWidth="1.1" />
      <rect x="76" y="46" width="96" height="6" rx="3" fill={FAINT} />
      <rect x="76" y="58" width="62" height="4" rx="2" fill={FAINT} />
      <rect x="40" y="98" width="132" height="9" rx="4.5" fill={INK} opacity="0.85" />
      <rect x="40" y="118" width="84" height="4" rx="2" fill={FAINT} />
      <rect x="196" y="118" width="62" height="4" rx="2" fill={FAINT} />
      <line x1="40" y1="146" x2="282" y2="146" stroke={FAINT} />
      {rows.map((row, i) => (
        <g key={i}>
          <rect x="40" y={rowY(i) - 7} width={row.label} height="5" rx="2.5" fill={FAINT} />
          <text x="196" y={rowY(i)} fontFamily={MONO} fontSize="13" fill={INK}>{row.value}</text>
          <rect x="246" y={rowY(i) - 6} width="36" height="4" rx="2" fill={FAINT} />
          {row.read !== undefined && (
            <rect className="draw" pathLength={1} style={{ animationDelay: `${0.3 + row.read * 0.35}s` }}
              x="188" y={rowY(i) - 16} width="48" height="22" rx="4" fill="none" stroke={ACCENT} strokeWidth="1.5" />
          )}
        </g>
      ))}
      <circle cx="84" cy="370" r="24" fill="none" stroke={FAINT} strokeWidth="1.5" strokeDasharray="3 4" />
      <path d="M176 378c14-22 22-22 26-6s14 12 22-6 16-10 20 2 14 6 24-8" fill="none" stroke={INK} strokeWidth="1.2" opacity="0.5" />

      {/* what was read from it */}
      <rect x="342" y="112" width="200" height="236" rx="12" fill="#fff" stroke={INK} strokeWidth="1.25" />
      <text x="360" y="144" fontSize="16" fontWeight="600" fill={INK}>{t('Blood test')}</text>
      <text x="360" y="164" fontFamily={MONO} fontSize="11" fill={INK} opacity="0.5">12.03.2026</text>
      {results.map((r, i) => {
        const from = rowY(rows.findIndex(row => row.read === i)) - 5;
        return (
          <g key={i}>
            <line x1="360" y1={r.y - 28} x2="524" y2={r.y - 28} stroke={FAINT} />
            <text x="360" y={r.y - 8} fontSize="12" fill={INK} opacity="0.6">{r.name}</text>
            <text x="360" y={r.y + 11} fontFamily={MONO} fontSize="15" fontWeight="500" fill={INK}>{r.value}</text>
            {r.low && (
              <g>
                <rect x="472" y={r.y - 1} width="52" height="17" rx="8.5" fill="#fef3c7" />
                <text x="498" y={r.y + 11} textAnchor="middle" fontSize="10" fontWeight="600" fill="#92400e">{t('Low')}</text>
              </g>
            )}
            <path className="draw" pathLength={1} style={{ animationDelay: `${0.55 + i * 0.35}s` }}
              d={`M236 ${from} C 290 ${from}, 300 ${r.y + 6}, 350 ${r.y + 6}`} fill="none" stroke={ACCENT} strokeWidth="1.5" />
            <circle cx="350" cy={r.y + 6} r="3" fill={ACCENT} />
          </g>
        );
      })}
    </svg>
  );
}

/** Where a record is, and in what form: readable on the device, sealed before it leaves, kept sealed on the server. */
function SealingDrawing() {
  const { t } = useI18n();
  const cipher = ['9f3a·c07e·51d2', 'e8b1·04aa·7c3f', '2d6e·b9f0·a813', '71c4·5e2b·d09a', 'b30f·86d1·4e7c'];
  const stages = [
    {
      label: t('On your device'),
      text: t('Read, searched and kept in your browser, opened with your password.'),
      art: (
        <>
          <rect x="20" y="16" width="200" height="128" rx="10" fill="#fff" stroke={INK} strokeWidth="1.25" />
          <line x1="20" y1="36" x2="220" y2="36" stroke={FAINT} />
          {[34, 44, 54].map(x => <circle key={x} cx={x} cy="26" r="3" fill={FAINT} />)}
          <rect x="44" y="50" width="70" height="80" rx="4" fill="none" stroke={INK} strokeWidth="1.1" />
          {[40, 52, 30, 46, 36].map((w, i) => <rect key={i} x="52" y={62 + i * 12} width={w} height="4" rx="2" fill={FAINT} />)}
          {[72, 56, 64].map((w, i) => <rect key={i} x="128" y={58 + i * 22} width={w} height="12" rx="3" fill="none" stroke={ACCENT} strokeWidth="1.4" />)}
        </>
      ),
    },
    {
      label: t('Sealed'),
      text: t('Locked with keys made from your password, before anything is saved.'),
      art: (
        <>
          {[0, 1, 2].map(i => (
            <g key={i} transform={`translate(${56 + i * 16} ${18 + i * 14})`}>
              <rect width="112" height="84" rx="8" fill="#fff" stroke={INK} strokeWidth="1.2" />
              {cipher.map((_, r) => (
                <text key={r} x="10" y={18 + r * 14} fontFamily={MONO} fontSize="8.5" fill={INK} opacity="0.28">{cipher[(r + i) % cipher.length]}</text>
              ))}
            </g>
          ))}
          <Lock x={144} y={92} />
        </>
      ),
    },
    {
      label: t('On the server'),
      text: t('Kept as sealed pieces it cannot open.'),
      art: (
        <>
          <rect x="52" y="14" width="136" height="132" rx="10" fill="#fff" stroke={INK} strokeWidth="1.25" />
          {[0, 1, 2].map(i => (
            <g key={i}>
              <rect x="66" y={28 + i * 38} width="108" height="28" rx="5" fill="none" stroke={FAINT} strokeWidth="1.2" />
              <circle cx="80" cy={42 + i * 38} r="3" fill={FAINT} />
              <rect x="94" y={36 + i * 38} width="44" height="12" rx="3" fill={FAINT} />
              <Lock x={158} y={37 + i * 38} scale={0.55} />
            </g>
          ))}
        </>
      ),
    },
  ];
  return (
    <ol className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-6">
      {stages.map((stage, i) => (
        <li key={i} className="relative">
          <svg viewBox="0 0 240 160" className="h-auto w-full max-w-xs" aria-hidden="true">{stage.art}</svg>
          {i < stages.length - 1 && (
            <svg viewBox="0 0 40 16" className="absolute -right-6 top-[22%] hidden w-8 sm:block" aria-hidden="true">
              <path d="M2 8h32m-6-5 6 5-6 5" fill="none" stroke="rgb(var(--ink) / 0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <p className="mt-4 font-label text-xs font-medium uppercase tracking-[0.14em] text-accent">
            <span className="text-ink/40">{i + 1} · </span>{stage.label}
          </p>
          <p className="mt-2 max-w-xs leading-relaxed text-ink/70">{stage.text}</p>
        </li>
      ))}
    </ol>
  );
}
