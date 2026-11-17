import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Pager from './Pager';

/** Previous and Next with the counter between them, under a list of one page of many (T-31). */
const draw = (page: number, total: number, limit = 25) => renderToStaticMarkup(<Pager page={page} total={total} limit={limit} onPage={() => undefined} />).replace(/<!-- -->/g, '');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the pager', () => {
  it('is not drawn while everything fits on one page', () => {
    expect(draw(1, 0)).toBe('');
    expect(draw(1, 25)).toBe('');
  });

  it('says where the page is among the rows, and holds Previous on the first page', () => {
    const html = draw(1, 312);
    expect(text(html)).toBe('Previous 1–25 of 312 Next');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Previous/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Next/);
  });

  it('ends at the last row on the last page and holds Next there', () => {
    const html = draw(13, 312);
    expect(text(html)).toBe('Previous 301–312 of 312 Next');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Next/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Previous/);
  });
});
