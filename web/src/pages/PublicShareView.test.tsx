import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => ({ state: 'limit' as string }));
vi.mock('../core/share/access', () => ({ useShareAccess: () => ({ state: access.state, ask: async () => undefined, error: '', code: '' }) }));

Object.assign(globalThis, {
  document: { documentElement: { getAttribute: () => null } },
  window: { matchMedia: () => ({ matches: false }), location: { search: '' } },
});

const { default: PublicShareView, matchesSearch } = await import('./PublicShareView');
const { default: ShareOverview } = await import('../components/ShareOverview');
const { ConnectionsView } = await import('../components/SharedConnections');
const { tagName } = await import('../titles');
const { I18nProvider } = await import('../i18n');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
const render = () => text(renderToStaticMarkup(<MemoryRouter initialEntries={['/share/abc']}><Routes><Route path="/share/:id" element={<PublicShareView />} /></Routes></MemoryRouter>));

describe('a share link whose owner’s plan has used up the month', () => {
  it('tells the reader the link is unavailable until next month, in the words of a limit and not of a broken address', () => {
    access.state = 'limit';
    const page = render();
    expect(page).toContain('Link unavailable');
    expect(page).toContain('This link has reached its limit for this month. It opens again next month.');
    expect(page).not.toContain('incomplete or damaged');
  });

  it('is not what a link that has ended or a damaged address says', () => {
    access.state = 'gone';
    expect(render()).toContain('This link is no longer active.');
    access.state = 'broken';
    expect(render()).toContain('incomplete or damaged');
  });
});


/** The first screen a doctor sees (T-02) and what the page says in the doctor's language (T-04), search (T-03). */
const draw = (node: JSX.Element) => text(renderToStaticMarkup(<I18nProvider><MemoryRouter>{node}</MemoryRouter></I18nProvider>));
const OVERVIEW = { by: 'Ana Exemplu', note: 'For a new endocrinologist', now: { medications: ['Levothyroxine 50 µg, once a day'], allergies: ['penicillin'], conditions: [], written_on: '2026-11-17' } };

describe('the overview a doctor opens on', () => {
  it('says whose records, when they were shared and until when, why, what the owner takes now and the years the documents cover', () => {
    const page = draw(<ShareOverview overview={OVERVIEW} createdAt="2026-11-17T10:00:00.000Z" expiresAt="2026-11-24T10:00:00.000Z" count={38} years={['2025', '2026']} />);
    for (const shown of ['Records of Ana Exemplu', 'Shared', 'Open until', 'Why this was shared', 'For a new endocrinologist', 'Written by the patient on', 'Medicines', 'Levothyroxine 50 µg, once a day', 'Allergies', 'penicillin', '38 documents, 2025–2026']) expect(page).toContain(shown);
    expect(page).not.toContain('Conditions');
  });

  it('leaves out the owner’s name, the note and the medicines where the owner left them out, and still says when it ends and how many documents', () => {
    const page = draw(<ShareOverview overview={{ by: null, note: null, now: null }} createdAt={null} expiresAt="2026-11-24T10:00:00.000Z" count={1} years={['2026', '2026']} />);
    expect(page).not.toContain('Records of');
    expect(page).not.toContain('Why this was shared');
    expect(page).not.toContain('Medicines');
    expect(page).toContain('Open until');
    expect(page).toContain('1 document, 2026');
    expect(draw(<ShareOverview overview={null} expiresAt={null} count={0} />)).toContain('0 documents');
  });

  it('states no clinical conclusion of its own: its words are the owner’s and its headings are labels', () => {
    const page = draw(<ShareOverview overview={OVERVIEW} createdAt="2026-11-17T10:00:00.000Z" expiresAt="2026-11-24T10:00:00.000Z" count={3} years={['2026', '2026']} />);
    expect(page).not.toMatch(/diagnos|abnormal|dangerous|should|recommend|normal range|outside the range/i);
  });
});

describe('searching the shared list', () => {
  const doc = { id: 'd1', title: 'Analize hormonale', ai_summary: 'TSH crescut, T4 normal', user_notes: null, provider: 'Clinica Exemplu', doc_type: 'lab_result', doc_date: '2026-03-04', translation: { status: 'ok', title: 'Hormonanalyse', ai_summary: 'TSH erhöht', user_notes: null } } as never;
  const t = (s: string) => s;

  it('finds a word in the title or summary, in the translation, without regard to case or accents, and every word of the query must be there', () => {
    expect(matchesSearch(doc, 'tsh', false, t)).toBe(true);
    expect(matchesSearch(doc, 'hormonanalyse', false, t)).toBe(true);
    expect(matchesSearch(doc, 'clinică', false, t)).toBe(true);
    expect(matchesSearch(doc, 'tsh erhöht', false, t)).toBe(true);
    expect(matchesSearch(doc, 'tsh cardiology', false, t)).toBe(false);
    expect(matchesSearch(doc, '   ', false, t)).toBe(true);
  });

  it('looks in the original only when the reader chose it', () => {
    expect(matchesSearch(doc, 'erhöht', true, t)).toBe(false);
    expect(matchesSearch(doc, 'crescut', true, t)).toBe(true);
  });
});

describe('what the page says in the reader’s language', () => {
  it('shows a tag the app made in the reader’s language and one the owner wrote as written', () => {
    const t = (s: string) => ({ Cardiology: 'Kardiologie' }[s] ?? s);
    expect(tagName('cardiology', t)).toBe('Kardiologie');
    expect(tagName('lungs', t)).toBe('lungs');
  });

  it('shows no "Similar documents" block to a doctor, only the connections the owner confirmed', () => {
    const related = [{ id: 'c', title: 'Loosely alike', doc_type: null, provider: null, doc_date: '2025-01-01', reasons: [{ kind: 'similar' }] }];
    const data = {
      chain: { nodes: [{ id: 'a', title: 'Consultation', doc_type: null, provider: null, doc_date: '2026-01-01' }, { id: 'b', title: 'Tests', doc_type: null, provider: null, doc_date: '2026-01-02' }], edges: [{ from: 'a', to: 'b', kind: 'requests' }] },
      related,
    } as never;
    const page = draw(<ConnectionsView data={data} id="b" titleOf={() => null} />);
    expect(page).toContain('Connected documents');
    expect(page).not.toContain('Similar documents');
    expect(page).not.toContain('Loosely alike');
    expect(draw(<ConnectionsView data={{ chain: null, related } as never} id="b" titleOf={() => null} />)).toBe('');
  });
});
