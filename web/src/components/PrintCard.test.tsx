import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_CARD } from 'spine-core/emergency';
import PrintCard from './PrintCard';

/** A contact's number on the printed card moves to the next line whole, rather than breaking where a space in it falls. */
describe('the printed card', () => {
  it('keeps a contact’s phone number on one line', () => {
    const card = { ...EMPTY_CARD, name: 'Ioana Test', contacts: [{ name: 'Mihai Test', relation: 'brother', phone: '+40 700 000 111' }] };
    const html = renderToStaticMarkup(<PrintCard card={card} qr={{ text: 'https://example.invalid/c/x', online: true }} />);
    expect(html).toContain('Mihai Test (brother) <span class="card-phone">+40 700 000 111</span>');
  });
});
