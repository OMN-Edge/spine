import type { ReactNode } from 'react';
import { useI18n } from '../i18n';

/**
 * The drawings of the pages a visitor reads before an account. Each shows how something works rather than decorating: a report whose
 * values point to what was read from them (grounding), a record sealed on the device before the server keeps it, a family's records kept
 * apart, and the emergency card. The records in them are invented. Colours are the public pages' tokens, so both themes draw them.
 */
const INK = 'rgb(var(--ink))';
const FAINT = 'rgb(var(--ink) / 0.14)';
const ACCENT = 'rgb(var(--accent))';
const HONEY = 'rgb(var(--honey))';
const SURFACE = 'rgb(var(--surface))';
// Numbers set as on a printed report; the system's own monospace, since nothing is bundled for so few characters.
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function Lock({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <rect x="-11" y="-2" width="22" height="17" rx="3.5" fill={ACCENT} />
      <path d="M-6 -2v-4a6 6 0 0 1 12 0v4" fill="none" stroke={ACCENT} strokeWidth="2.2" />
    </g>
  );
}

/**
 * A lab report drawn in lines, three of its values boxed, each joined to the value read from it: the grounding every extracted field has.
 * The lines draw themselves once (not for a reader who asks for less motion).
 */
export function ReadingDrawing() {
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
    <svg viewBox="0 0 560 440" className="h-auto w-full" role="img" aria-label={t('A lab report whose values are each joined to the value read from them.')}>
      {/* the page */}
      <rect x="18" y="18" width="286" height="404" rx="6" fill={SURFACE} stroke={INK} strokeOpacity="0.5" strokeWidth="1.25" />
      <rect x="40" y="42" width="26" height="26" rx="5" fill="none" stroke={INK} strokeOpacity="0.6" strokeWidth="1.1" />
      <rect x="76" y="46" width="96" height="6" rx="3" fill={FAINT} />
      <rect x="76" y="58" width="62" height="4" rx="2" fill={FAINT} />
      <rect x="40" y="98" width="132" height="9" rx="4.5" fill={INK} opacity="0.8" />
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
      <path d="M176 378c14-22 22-22 26-6s14 12 22-6 16-10 20 2 14 6 24-8" fill="none" stroke={INK} strokeWidth="1.2" opacity="0.45" />

      {/* what was read from it */}
      <rect x="342" y="112" width="200" height="236" rx="12" fill={SURFACE} stroke={INK} strokeOpacity="0.5" strokeWidth="1.25" />
      <text x="360" y="144" fontSize="16" fontWeight="600" fill={INK}>{t('Blood test')}</text>
      <text x="360" y="164" fontFamily={MONO} fontSize="11" fill={INK} opacity="0.55">12.03.2026</text>
      {results.map((r, i) => {
        const from = rowY(rows.findIndex(row => row.read === i)) - 5;
        return (
          <g key={i}>
            <line x1="360" y1={r.y - 28} x2="524" y2={r.y - 28} stroke={FAINT} />
            <text x="360" y={r.y - 8} fontSize="12" fill={INK} opacity="0.65">{r.name}</text>
            {/* A value the report flags is marked as with a highlighter: dark on honey in both themes. */}
            {r.low && <rect x="356" y={r.y - 5} width="86" height="22" rx="4" fill={HONEY} opacity="0.8" />}
            <text x="360" y={r.y + 11} fontFamily={MONO} fontSize="15" fontWeight="500" fill={r.low ? '#17292a' : INK}>{r.value}</text>
            {r.low && <text x="452" y={r.y + 10} fontSize="11" fontWeight="600" fill={INK} opacity="0.7">{t('Low')}</text>}
            <path className="draw" pathLength={1} style={{ animationDelay: `${0.55 + i * 0.35}s` }}
              d={`M236 ${from} C 290 ${from}, 300 ${r.y + 6}, 350 ${r.y + 6}`} fill="none" stroke={ACCENT} strokeWidth="1.5" />
            <circle cx="350" cy={r.y + 6} r="3" fill={ACCENT} />
          </g>
        );
      })}
    </svg>
  );
}

/** Where a record is, and in what form: readable on the device, sealed before it leaves, kept sealed on the server. A sequence, in order. */
export function SealingDrawing() {
  const { t } = useI18n();
  const cipher = ['9f3a c07e 51d2', 'e8b1 04aa 7c3f', '2d6e b9f0 a813', '71c4 5e2b d09a', 'b30f 86d1 4e7c'];
  const stages = [
    {
      label: t('On your device'),
      text: t('Read, searched and kept in your browser, opened with your password.'),
      art: (
        <>
          <rect x="20" y="16" width="200" height="128" rx="10" fill={SURFACE} stroke={INK} strokeOpacity="0.5" strokeWidth="1.25" />
          <line x1="20" y1="36" x2="220" y2="36" stroke={FAINT} />
          {[34, 44, 54].map(x => <circle key={x} cx={x} cy="26" r="3" fill={FAINT} />)}
          <rect x="44" y="50" width="70" height="80" rx="4" fill="none" stroke={INK} strokeOpacity="0.6" strokeWidth="1.1" />
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
              <rect width="112" height="84" rx="8" fill={SURFACE} stroke={INK} strokeOpacity="0.5" strokeWidth="1.2" />
              {cipher.map((_, r) => (
                <text key={r} x="10" y={18 + r * 14} fontFamily={MONO} fontSize="8.5" fill={INK} opacity="0.3">{cipher[(r + i) % cipher.length]}</text>
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
          <rect x="52" y="14" width="136" height="132" rx="10" fill={SURFACE} stroke={INK} strokeOpacity="0.5" strokeWidth="1.25" />
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
    <ol className="grid gap-10 sm:grid-cols-3 sm:gap-6">
      {stages.map((stage, i) => (
        <li key={i} className="relative">
          <svg viewBox="0 0 240 160" className="h-auto w-full max-w-xs" aria-hidden="true">{stage.art}</svg>
          {i < stages.length - 1 && (
            <svg viewBox="0 0 40 16" className="absolute -right-6 top-[22%] hidden w-8 sm:block" aria-hidden="true">
              <path d="M2 8h32m-6-5 6 5-6 5" fill="none" stroke="rgb(var(--ink) / 0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <h3 className="mt-4 flex items-center gap-2 font-medium">
            <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/40 font-display text-sm text-accent">{i + 1}</span>
            {stage.label}
          </h3>
          <p className="mt-2 max-w-xs leading-relaxed text-ink/70">{stage.text}</p>
        </li>
      ))}
    </ol>
  );
}

/** Who can see what, plainly: the list the front page and the page on protection both show. On the dark band. */
export function WhoCanSee() {
  const { t } = useI18n();
  const Row = ({ who, children }: { who: string; children: ReactNode }) => (
    <div className="grid gap-1 border-b border-band-fg/15 py-5 sm:grid-cols-[14rem_1fr] sm:gap-8">
      <dt className="font-medium text-accent-light">{who}</dt>
      <dd className="leading-relaxed text-band-fg/90">{children}</dd>
    </div>
  );
  return (
    <dl className="max-w-4xl border-t border-band-fg/15">
      <Row who={t('You')}>{t('Everything, on your own device, once you have unlocked it.')}</Row>
      <Row who={t('A doctor you share with')}>{t('Only what the link shares, until it ends. No account or app needed.')}</Row>
      <Row who={t('People you let in')}>{t('The records of the person you let them into, as someone who can change them or only read them, until you end it.')}</Row>
      <Row who={t('The AI relay')}>{t('The text of a request while it is answered. It does not store or log it.')}</Row>
      <Row who={t('The server')}>{t("Your email, the size and time of each sealed save, and your share links' dates and where they were opened. Not what your records say.")}</Row>
    </dl>
  );
}

/** One vertebral body, as the mark draws it: rounded, waisted at the sides, `w` wide and `h` high, centred on `cx`. */
function vertebra(cx: number, y: number, w: number, h: number): string {
  const x = cx - w / 2;
  const r = Math.min(5, h / 2.4);
  const notch = w * 0.11; // the waist the mark has at each side
  const mid = y + h / 2;
  return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}C${x + w - notch} ${mid - h * 0.2} ${x + w - notch} ${mid + h * 0.2} ${x + w} ${y + h - r}`
    + `Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}C${x + notch} ${mid + h * 0.2} ${x + notch} ${mid - h * 0.2} ${x} ${y + r}Q${x} ${y} ${x + r} ${y}Z`;
}

/**
 * Three people's records side by side: yours, a child's and a parent's. Each document is a vertebra on that person's spine (the timeline
 * draws them so), each spine stands on a lock of its own, and three documents are named, one with a value marked as with a highlighter.
 * The vertebrae settle into place once, from the bottom (not for a reader who asks for less motion). The people and documents are invented.
 */
export function FamilySpines() {
  const { t } = useI18n();
  const people = [
    { name: t('You'), cx: 104, count: 8, w: 62, tone: ACCENT, opacity: 0.92 },
    { name: t('Ana, age 9'), cx: 252, count: 5, w: 46, tone: ACCENT, opacity: 0.55 },
    { name: t('Your father'), cx: 478, count: 10, w: 66, tone: INK, opacity: 0.72 },
  ];
  const base = 372;
  const step = (w: number) => w * 0.42; // a smaller person, smaller vertebrae
  const yOf = (p: typeof people[number], i: number) => base - (i + 1) * (step(p.w) + 6);
  // A spine is not a column: each one curves a little, as a back does.
  const xOf = (p: typeof people[number], i: number) => p.cx + Math.sin((i / Math.max(1, p.count - 1)) * Math.PI * 1.4) * p.w * 0.12;
  const tags = [
    { person: 0, at: 5, side: 1, title: t('Blood test'), detail: t('Ferritin 18, low'), mark: true },
    { person: 1, at: 3, side: 1, title: t('Vaccinations'), detail: t('Up to date') },
    { person: 2, at: 8, side: -1, title: t('Cardiology'), detail: t('Follow-up in March') },
  ];
  return (
    <svg viewBox="0 0 560 440" className="h-auto w-full" role="img" aria-label={t('Three people’s records, kept apart: yours, a child’s and a parent’s. Each document is a vertebra on that person’s spine, and each spine has a lock of its own.')}>
      {people.map((p, pi) => (
        <g key={pi}>
          {Array.from({ length: p.count }, (_, i) => {
            const h = step(p.w);
            const y = yOf(p, i);
            const w = p.w * (1 - 0.035 * i); // widest at the bottom, as a spine is
            return (
              <g key={i} className="settle" style={{ animationDelay: `${0.12 + pi * 0.18 + i * 0.07}s` }}>
                <path d={vertebra(xOf(p, i), y, w, h)} fill={p.tone} opacity={p.opacity} />
                {i > 0 && <rect x={xOf(p, i) - w * 0.36} y={y + h + 1.5} width={w * 0.72} height="3" rx="1.5" fill={p.tone} opacity={p.opacity * 0.35} />}
              </g>
            );
          })}
          {/* the lock each person's records have */}
          <g transform={`translate(${p.cx} ${base + 22})`}>
            <rect x="-10" y="-1" width="20" height="15" rx="3.5" fill="none" stroke={INK} strokeOpacity="0.55" strokeWidth="1.5" />
            <path d="M-5.5 -1v-3.5a5.5 5.5 0 0 1 11 0V-1" fill="none" stroke={INK} strokeOpacity="0.55" strokeWidth="1.5" />
            <circle cx="0" cy="6" r="1.8" fill={INK} fillOpacity="0.55" />
          </g>
          <text x={p.cx} y={base + 60} textAnchor="middle" fontSize="14" fill={INK} opacity="0.75">{p.name}</text>
        </g>
      ))}
      {tags.map((tag, ti) => {
        const p = people[tag.person];
        const y = yOf(p, tag.at) + step(p.w) / 2;
        const fromX = xOf(p, tag.at) + tag.side * (p.w * (1 - 0.035 * tag.at) / 2 + 2);
        const cardW = 136;
        const cardX = tag.side > 0 ? fromX + 22 : fromX - 22 - cardW;
        return (
          <g key={ti} className="settle" style={{ animationDelay: `${1.0 + ti * 0.2}s` }}>
            <path d={`M${fromX} ${y}H${tag.side > 0 ? cardX : cardX + cardW}`} stroke={INK} strokeOpacity="0.35" strokeWidth="1.2" strokeDasharray="2 3" />
            <circle cx={fromX} cy={y} r="2.5" fill={INK} opacity="0.5" />
            <rect x={cardX} y={y - 26} width={cardW} height="52" rx="8" fill={SURFACE} stroke={INK} strokeOpacity="0.16" />
            <text x={cardX + 12} y={y - 6} fontSize="13" fontWeight="600" fill={INK}>{tag.title}</text>
            {/* As long as the words it marks, in any language (about 6 px a letter at this size), and never wider than the card. */}
            {tag.mark && <rect x={cardX + 9} y={y + 4} width={Math.min(cardW - 18, tag.detail.length * 6.2 + 8)} height="15" rx="3" fill={HONEY} opacity="0.8" />}
            {/* Marked as with a highlighter: dark on honey in both themes, as ink on a marked line is. */}
            <text x={cardX + 12} y={y + 15} fontSize="11.5" fill={tag.mark ? '#17292a' : INK} opacity={tag.mark ? 0.9 : 0.75}>{tag.detail}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** The card: a bank card's proportions, a cross, the person's name in lines and the code that opens it. Not a real code. */
export function EmergencyCardDrawing() {
  const { t } = useI18n();
  const cells = [[0, 0], [1, 0], [3, 0], [0, 1], [2, 1], [4, 1], [1, 2], [3, 2], [4, 2], [0, 3], [2, 3], [3, 3], [1, 4], [2, 4], [4, 4]];
  return (
    <svg viewBox="0 0 324 204" className="h-auto w-full max-w-[22rem] -rotate-2" role="img" aria-label={t('An emergency card the size of a bank card, with a code that opens it.')}>
      <rect x="2" y="2" width="320" height="200" rx="16" fill={SURFACE} stroke={INK} strokeOpacity="0.2" strokeWidth="1.5" />
      <g transform="translate(26 26)">
        <rect width="30" height="30" rx="7" fill={ACCENT} />
        <path d="M15 7v16M7 15h16" stroke={SURFACE} strokeWidth="4" strokeLinecap="round" />
      </g>
      <text x="68" y="47" fontSize="15" fontWeight="600" fill={INK}>{t('Emergency card')}</text>
      {[78, 100, 122, 144].map((y, i) => <rect key={y} x="26" y={y} width={[150, 118, 136, 96][i]} height="8" rx="4" fill={INK} opacity={i === 0 ? 0.55 : 0.18} />)}
      <rect x="26" y="96" width="122" height="16" rx="3" fill={HONEY} opacity="0.45" />
      <g transform="translate(212 74)">
        {/* A code is drawn dark on white in both themes, as the card's own code is (CardQr), because that is what a phone reads. */}
        <rect x="-8" y="-8" width="96" height="96" rx="8" fill="#fff" />
        {cells.map(([x, y]) => <rect key={`${x}${y}`} x={x * 16} y={y * 16} width="14" height="14" rx="2" fill="#111" />)}
      </g>
    </svg>
  );
}
