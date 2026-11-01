import { cardText, type CardContent } from 'spine-core/emergency';
import CardQr from './CardQr';
import { useI18n } from '../i18n';

/** What fits on the front of a wallet-sized card at a readable size. */
const FRONT_BYTES = 420;

/**
 * The card on paper, the size of a bank card (85.6 by 54 mm), front and back side by side with a dotted line to cut along. It is on the page
 * all the time and shown only when printing a card (`printCard`): the page's own print is left as it was. Made from the card others read, so
 * a detail that is off is not on the paper. The back holds a code: the online one if the card is on, else the offline one.
 */
export default function PrintCard({ card, qr }: { card: CardContent; qr: { text: string; online: boolean } }) {
  const { t } = useI18n();
  const { text, omitted } = cardText(card, FRONT_BYTES);
  const rest = text.split('\n').slice(1); // the first line is the English title; the page's own, translated, is above
  return (
    <div className="print-card" aria-hidden="true">
      <div className="card-face">
        <p className="card-head">{t('Emergency card')}</p>
        {rest.map((line, i) => <p key={i} className={i === 0 && line.startsWith('Name: ') ? 'card-name' : undefined}>{i === 0 ? line.replace(/^Name: /, '') : line}</p>)}
        {omitted > 0 && <p className="card-more">{t('More on the card behind the code.')}</p>}
      </div>
      <div className="card-face card-back">
        <CardQr text={qr.text} level={qr.online ? 'M' : 'L'} label={t('Code on the card')} className="card-qr" />
        <p>{qr.online ? t('Scan to open the full card.') : t('This code holds the card. Anyone who sees it can read it.')}</p>
        <p className="card-small">Spine</p>
      </div>
    </div>
  );
}

/** Prints only the card-sized copy: the page is marked for the print and unmarked after, whatever the browser does. */
export function printCard(): void {
  document.body.classList.add('printing-card');
  const done = () => { document.body.classList.remove('printing-card'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  // A browser that prints without telling us (some do) must not leave the page marked.
  setTimeout(done, 2000);
}
