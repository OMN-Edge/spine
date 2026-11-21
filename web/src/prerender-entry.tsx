import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Landing from './pages/Landing';
import HowItWorks from './pages/HowItWorks';
import Protection from './pages/Protection';
import Encryption from './pages/Encryption';
import SecurityChecks from './pages/SecurityChecks';
import Families from './pages/Families';
import ForDoctors from './pages/ForDoctors';

/**
 * The public pages whose text is the same for everyone, drawn once at build time (`scripts/prerender.mjs`) so that what a search engine reads without running a script is the page
 * and not a title and one heading. The pages that depend on the instance (the prices, the legal texts, the operator's company line) or on the commit are left to the script: their
 * head is written for them, and the page draws itself as before. The browser replaces what is drawn here with the live page as soon as the app starts.
 */
export const PRERENDERED: Record<string, () => JSX.Element> = {
  '/': () => <Landing />,
  '/how-it-works': () => <HowItWorks />,
  '/protection': () => <Protection />,
  '/encryption': () => <Encryption />,
  '/security-checks': () => <SecurityChecks />,
  '/families': () => <Families />,
  '/for-doctors': () => <ForDoctors />,
};

export const renderPublic = (path: string): string => {
  const page = PRERENDERED[path];
  if (!page) throw new Error(`${path} is not a prerendered page`);
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{page()}</MemoryRouter>);
};
