import type { DocumentBrand } from 'spine-anaf/index.js';

/** The four vertebral bodies of the mark, in its 32-unit box (the same geometry as `web/public/favicon.svg`), for the header of an invoice. */
const MARK = [
  'M10.6 1.4H21.4Q22.5 1.4 22.5 2.5C20.99 3.14 20.99 5.46 22.5 6.1Q22.5 7.2 21.4 7.2H10.6Q9.5 7.2 9.5 6.1C11.01 5.46 11.01 3.14 9.5 2.5Q9.5 1.4 10.6 1.4Z',
  'M9.77 9.2H22.23Q23.33 9.2 23.33 10.3C21.82 10.94 21.82 13.26 23.33 13.9Q23.33 15 22.23 15H9.77Q8.67 15 8.67 13.9C10.18 13.26 10.18 10.94 8.67 10.3Q8.67 9.2 9.77 9.2Z',
  'M8.93 17H23.07Q24.17 17 24.17 18.1C22.66 18.74 22.66 21.06 24.17 21.7Q24.17 22.8 23.07 22.8H8.93Q7.83 22.8 7.83 21.7C9.34 21.06 9.34 18.74 7.83 18.1Q7.83 17 8.93 17Z',
  'M8.1 24.8H23.9Q25 24.8 25 25.9C23.49 26.54 23.49 28.86 25 29.5Q25 30.6 23.9 30.6H8.1Q7 30.6 7 29.5C8.51 28.86 8.51 26.54 7 25.9Q7 24.8 8.1 24.8Z',
];

/** What the invoice's header shows: Spine's name and mark, and the site it is served from. */
export function invoiceBrand(env: NodeJS.ProcessEnv = process.env): DocumentBrand {
  const site = env.SPINE_DOMAIN?.trim();
  return { name: 'Spine', mark: MARK, ...(site ? { site } : {}) };
}
