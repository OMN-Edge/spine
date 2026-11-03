import { Fragment } from 'react';
import { cardText, type CardContent } from 'spine-core/emergency';
import CardQr from './CardQr';
import { LogoMark } from './Logo';
import { useI18n } from '../i18n';

/** What fits on the front of a wallet-sized card at a readable size. */
const FRONT_BYTES = 420;

/** A line of the card's text, "Allergies: Penicillin; Peanuts", as its label and its items. The labels are English, as the offline code's are. */
const row = (line: string): { label: string; items: string[] } | null => {
  const at = line.indexOf(': ');
  return at > 0 ? { label: line.slice(0, at), items: line.slice(at + 2).split('; ') } : null;
};

/** An item of a row, with a contact's phone number kept on one line: a number broken across two is misread or misdialled. */
function Item({ item, phones }: { item: string; phones: string[] }) {
  const phone = phones.find(p => p && item.endsWith(p));
  if (!phone) return <>{item}</>;
  return <>{item.slice(0, item.length - phone.length)}<span className="card-phone">{phone}</span></>;
}

/**
 * The card on paper, the size of a bank card (85.6 by 54 mm, landscape): the front is what is written, in two columns (a small label, then
 * the value, allergies in red), the back the code; the mark is on both. Printed one of two ways (`printCard`):
 *  - at home: a page (A4 or Letter) with numbered steps, a 5 cm line to check the printer kept the size, and the card to cut out and fold,
 *    front and back joined along a long edge inside one dashed line to cut, a dotted line to fold along, the back upside down so it reads the
 *    right way once folded behind the front;
 *  - for a print shop: each side alone on a page of exactly its size, with no line, so the PDF a browser saves is what a card printer prints.
 * It is on the page all the time and shown only when printing a card: the page's own print is left as it was. Made from the card others read,
 * so a detail that is off is not on the paper. The back holds a code: the online one if the card is on, else the offline one.
 */
export default function PrintCard({ card, qr }: { card: CardContent; qr: { text: string; online: boolean } }) {
  const { t } = useI18n();
  const { text, omitted } = cardText(card, FRONT_BYTES);
  // The first line is the English title (the page's own, translated, is used); the name is the heading; the rest are label and value.
  const lines = text.split('\n').slice(1);
  const name = lines[0]?.startsWith('Name: ') ? lines.shift()!.slice(6) : '';
  const rows = lines.map(row).filter((r): r is NonNullable<ReturnType<typeof row>> => r !== null);
  return (
    <div className="print-card" aria-hidden="true">
      <div className="card-sheet">
        <p className="card-sheet-brand"><LogoMark className="card-mark" /><span>Spine</span></p>
        <h1>{name ? t('Emergency card for {name}', { name }) : t('Emergency card')}</h1>
        <ol>
          <li>{t('Print this page at 100% (“Actual size”), not “Fit to page”. The line below should measure 5 cm; if it does not, print it again.')}</li>
          <li>{t('Cut the card out along the dashed line.')}</li>
          <li>{t('Fold it along the dotted line, so the code is on the back.')}</li>
          <li>{t('Glue the two halves together, or laminate the card, and keep it with your ID.')}</li>
        </ol>
        <div className="card-ruler"><span className="card-ruler-line" /><span>5 cm</span></div>
      </div>
      <div className="card-strip">
        <div className="card-face card-front">
          <div className="card-top"><p className="card-head">{t('Emergency card')}</p><LogoMark className="card-mark" /></div>
          {name && <p className="card-name">{name}</p>}
          <dl className="card-rows">
            {rows.map((r, i) => (
              <div key={i} className={r.label === 'Allergies' ? 'card-row card-alert' : 'card-row'}>
                <dt>{r.label}</dt>
                <dd>{r.items.map((item, j) => <Fragment key={j}>{j > 0 && ' · '}<Item item={item} phones={card.contacts.map(c => c.phone)} /></Fragment>)}</dd>
              </div>
            ))}
          </dl>
          {omitted > 0 && <p className="card-more">{t('More on the card behind the code.')}</p>}
        </div>
        <div className="card-face card-back">
          <CardQr text={qr.text} level={qr.online ? 'M' : 'L'} label={t('Code on the card')} className="card-qr" />
          <p>{qr.online ? t('Scan to open the full card.') : t('This code holds the card. Anyone who sees it can read it.')}</p>
          <p className="card-brand"><LogoMark className="card-mark" /><span>Spine</span></p>
        </div>
      </div>
      <p className="card-sheet-foot">{t('Anyone who reads the card reads what is on it. If you lose it, make a new code on the emergency card page: the old one stops working.')}</p>
    </div>
  );
}

/** Prints only the card: at home (a page with the steps and the card to fold) or for a print shop (one side to a page of the card's size). */
export function printCard(layout: 'home' | 'shop' = 'home'): void {
  document.body.classList.add('printing-card', `printing-${layout}`);
  // For a print shop every page is the card's own size. The stylesheet says so with a named page; this says it to a browser that does not
  // know named pages, for this print only.
  const size = layout === 'shop' ? document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '@page { size: 85.6mm 54mm; margin: 0; }' })) : null;
  const done = () => { document.body.classList.remove('printing-card', 'printing-home', 'printing-shop'); size?.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  // A browser that prints without telling us (some do) must not leave the page marked.
  setTimeout(done, 2000);
}
