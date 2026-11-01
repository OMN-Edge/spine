import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Actions, P, PageIntro, PublicPage, Section, TextLink, usePublicOptions } from '../components/PublicPage';

/**
 * The cryptography, for a reader who wants the specifics: the algorithms, how the keys fit together, what "sealed" means and what is
 * not encrypted. Every figure here is the code's: web/src/crypto/keys.ts (Argon2id at 64 MiB and 3 passes, a 16-byte salt, the root split
 * with crypto_kdf, the key hierarchy), seal.ts (XChaCha20-Poly1305, a random 24-byte nonce in front, the context as associated data),
 * delegation.ts and core/share/keys.ts (sealed boxes, 256-bit share keys), enrolment.ts (80-bit codes), server/src/passwords.ts (the
 * sign-in value hashed again with Argon2id at 19 MiB and 2 passes) and docs/key-hierarchy.md. Change one with the code it describes.
 */
export default function Encryption() {
  const { t } = useI18n();
  const options = usePublicOptions();

  return (
    <PublicPage options={options}>
      <PageIntro title={t('Encryption, in detail')}>
        {t('For readers who want the specifics: which algorithms, how the keys fit together, and what “sealed” means. It all runs in your browser, with libsodium, a widely used open-source cryptography library. Nothing here is home-made.')}
      </PageIntro>

      <Section title={t('What “sealed” means')}>
        <P>{t('A sealed piece is encrypted and authenticated with XChaCha20-Poly1305, under a 256-bit key and a fresh random 192-bit nonce. Without the key it reads as random bytes.')}</P>
        <P>{t('With the key, it opens only if not one byte has changed, and only in the place it was sealed for: what the piece is (which record, which kind of key) is bound into the seal without being stored in it. A piece that was changed or moved fails to open, just as one opened with the wrong key does.')}</P>
        <div className="mt-8"><SealedPiece /></div>
      </Section>

      <Section title={t('Five levels of keys')} wide>
        <div className="max-w-2xl">
          <P>{t('Your records are not encrypted with your password. They are sealed under keys that are themselves sealed, level by level, up to a key made from your password.')}</P>
        </div>
        <KeyLadder levels={[
          { name: t('Master key'), from: t('Made from your master password'), text: t('Argon2id, with 64 MiB of memory, 3 passes and a random 16-byte salt, turns your password into a root key, which is split in two. One half is the master key, which never leaves your device. The other is the value you sign in with; it cannot be turned back into the master key or the password.') },
          { name: t('Account key'), from: t('Sealed under the master key, and under the recovery key'), text: t('256 random bits. It is sealed a second time under the recovery key, 256 random bits that exist only in the recovery kit you print.') },
          { name: t('Your key pair'), from: t('Sealed under the account key'), text: t('An X25519 key pair, for letting another account in. Its public half can be shown to anyone; its private half is sealed under the account key.') },
          { name: t('Profile key'), from: t('Sealed under the account key, one for each person'), text: t('256 random bits for each person you keep records for: you, a child, a parent.') },
          { name: t('Data key'), from: t('Sealed under the profile key, one for each piece'), text: t('256 random bits for each sealed piece: a set of changes, a part of the database, a file. Your records themselves are sealed under these.') },
        ]} />
        <div className="mt-10 max-w-2xl">
          <P>{t('The levels are what make the rest possible. Changing your password seals one key again, not your records. Ending someone’s access seals the data keys under a new profile key, without touching the records themselves.')}</P>
          <P>{t('A passkey can open the account key too. The authenticator gives your device 32 bytes it never shows anyone else (the WebAuthn PRF extension), and the account key is sealed under a key made from them.')}</P>
        </div>
      </Section>

      <Section title={t('Keys for other people')}>
        <ul className="space-y-4">
          <Item title={t('Someone you let in')}>{t('The person’s profile key is sealed to the other account’s public key, as a sealed box (X25519 with XSalsa20-Poly1305) that only that account’s private key opens.')}</Item>
          <Item title={t('A share link')}>{t('A copy of only what the link shares, sealed under a random 256-bit key of its own, which opens nothing else. The key is in the address after the # sign, which a browser never sends. A link that needs your approval leaves the key out: the visitor’s browser makes a key pair, and your device seals the share key to it.')}</Item>
          <Item title={t('The emergency card')}>{t('Sealed under its own random 256-bit key, which is in the card’s address and its code, after the # sign.')}</Item>
          <Item title={t('Codes for an invitation or a new device')}>{t('80 random bits, typed or followed from a link, used once and only for a short while: a week for an invitation, ten minutes for a device.')}</Item>
        </ul>
      </Section>

      <Section title={t('At a glance')} wide>
        <div>
          <table className="w-full border-collapse text-left text-sm">
            <thead className="hidden sm:table-header-group">
              <tr className="border-b border-ink/20">
                <th scope="col" className="py-3 pr-6 font-medium">{t('What for')}</th>
                <th scope="col" className="py-3 pr-6 font-medium">{t('Algorithm')}</th>
                <th scope="col" className="py-3 font-medium">{t('Settings')}</th>
              </tr>
            </thead>
            <tbody className="text-ink/80">
              <Row what={t('From your password to a key')} alg="Argon2id" settings={t('64 MiB of memory, 3 passes, random 16-byte salt')} />
              <Row what={t('Splitting one key into several')} alg={t('BLAKE2b (libsodium’s key derivation)')} settings={t('256-bit keys')} />
              <Row what={t('Sealing records and keys')} alg="XChaCha20-Poly1305" settings={t('256-bit key, random 192-bit nonce, 128-bit tag')} />
              <Row what={t('Sealing a key to another person')} alg={t('X25519 and XSalsa20-Poly1305 (sealed box)')} settings={t('256-bit keys')} />
              <Row what={t('The value you sign in with, where it is kept')} alg="Argon2id" settings={t('Hashed again before it is stored: 19 MiB, 2 passes, its own salt')} />
              <Row what={t('In transit')} alg="HTTPS" settings={t('Browsers told to use nothing else for a year (HSTS)')} />
              <Row what={t('The app itself')} alg={t('SHA-384 and SHA-256')} settings={t('Each script and style checked by the browser; a list of every file anyone can compare')} />
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={t('What is not encrypted')}>
        <P>{t('To store your records and send them back, the service has to see some things about them: your email address, how many sealed pieces you have, their sizes, when they changed and a rough kind for each; and for a share, when it ends, and when and from which country it was opened.')}</P>
        <P>{t('Everything about a document is inside the seal: its pages, title, date, tags, doctors, extracted values, summaries, your notes, and what search uses to compare meaning.')}</P>
      </Section>

      <Section title={t('What encryption cannot do')}>
        <ul className="space-y-3">
          <Item>{t('Anyone who has your master password can sign in and open your records, so choose one of at least 12 characters that you use nowhere else. Keep the recovery kit as carefully, away from your devices.')}</Item>
          <Item>{t('While your records are open on a device, whoever uses that device can read them.')}</Item>
          <Item>{t('For the AI features, the text of a request is decrypted on your device and sent, through the relay, to the AI model. The relay keeps none of it.')}</Item>
          <Item>{t('Your browser runs the app it is sent. You can check it is the published one:')} <TextLink to="/trust">{t('How to check this app')}</TextLink></Item>
          <Item>{t('Spine’s code has not yet been audited by an independent firm.')}</Item>
        </ul>
      </Section>

      <section className="border-t border-ink/10">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="max-w-xl font-display text-[clamp(1.7rem,3.2vw,2.4rem)] font-normal leading-tight">{t('See it with invented records first.')}</h2>
          <Actions options={options} className="mt-6" />
        </div>
      </section>
    </PublicPage>
  );
}

function Item({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 leading-relaxed text-ink/80">
      <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
      <span>{title && <strong className="font-medium text-ink">{title}. </strong>}{children}</span>
    </li>
  );
}

function Row({ what, alg, settings }: { what: string; alg: string; settings: string }) {
  return (
    <tr className="block border-b border-ink/10 py-3 align-top sm:table-row sm:py-0">
      <th scope="row" className="block font-normal text-ink/60 sm:table-cell sm:py-3 sm:pr-6 sm:text-ink/80">{what}</th>
      <td className="block font-medium text-ink sm:table-cell sm:py-3 sm:pr-6">{alg}</td>
      <td className="block sm:table-cell sm:py-3">{settings}</td>
    </tr>
  );
}

/**
 * The levels of keys, top to bottom: each one sealed under the one above it. A hierarchy read in order, so drawn as a line of stops with
 * what seals each one.
 */
function KeyLadder({ levels }: { levels: Array<{ name: string; from: string; text: string }> }) {
  return (
    <ol className="relative mt-10 max-w-3xl space-y-8 pl-10">
      <span aria-hidden="true" className="absolute bottom-3 left-[13px] top-3 w-0.5 rounded bg-accent/25" />
      {levels.map((level, i) => (
        <li key={level.name} className="relative">
          <span aria-hidden="true" className="absolute -left-10 top-0 flex h-7 w-7 items-center justify-center rounded-full border-2 border-accent bg-paper">
            <KeyGlyph />
          </span>
          <p className="font-display text-xl">{level.name}</p>
          <p className="mt-0.5 text-sm text-accent">{i === 0 ? level.from : `↑ ${level.from}`}</p>
          <p className="mt-2 leading-relaxed text-ink/75">{level.text}</p>
        </li>
      ))}
    </ol>
  );
}

function KeyGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <circle cx="5" cy="8" r="3" fill="none" stroke="rgb(var(--accent))" strokeWidth="1.6" />
      <path d="M8 8h6.5M12 8v2.5M14 8v2" fill="none" stroke="rgb(var(--accent))" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * One sealed piece, as it is stored: 24 random bytes of nonce, the encrypted content, and the 16-byte tag that fails if a byte changes. What
 * the piece is, which record and which kind, is bound into the tag and not stored: drawn as a dashed frame around the piece, outside it.
 * Built in HTML rather than a drawing so that on a phone its three parts stack and stay legible.
 */
function SealedPiece() {
  const { t } = useI18n();
  const hex = (n: number, from = 0) => ['8f', '3a', 'c0', '7e', '51', 'd2', 'e8', 'b1', '04', 'aa', '7c', '3f', '2d', '6e', 'b9', 'f0', 'a8', '13'].slice(from, from + n).join(' ');
  const Part = ({ name, size, bytes, tag = false, grow = false }: { name: string; size: string; bytes: string; tag?: boolean; grow?: boolean }) => (
    <div className={grow ? 'sm:flex-1' : 'sm:w-36'}>
      <div className={`truncate rounded-lg border px-3 py-4 font-mono text-sm ${tag ? 'border-accent bg-accent/10 text-accent' : 'border-ink/30 bg-surface text-ink/45'}`}>{bytes}</div>
      <p className="mt-2 text-sm font-medium">{name}</p>
      <p className="text-xs text-ink/60">{size}</p>
    </div>
  );
  return (
    <figure>
      <div className="rounded-xl border border-dashed border-accent/60 p-4">
        <p className="mb-4 text-sm text-accent">{t('Bound in, not stored: which record, which kind')}</p>
        <div className="flex flex-col gap-4 sm:flex-row sm:gap-2" role="img" aria-label={t('A sealed piece: a random nonce, the encrypted content, and a tag that checks it, with what the piece is bound into the seal but not stored.')}>
          <Part name={t('Nonce')} size={t('24 random bytes')} bytes={hex(4)} />
          <Part name={t('Your data, encrypted')} size={t('as long as the data')} bytes={`${hex(10, 2)} …`} grow />
          <Part name={t('Authentication tag')} size={t('16 bytes')} bytes={hex(4, 10)} tag />
        </div>
      </div>
      <figcaption className="mt-3 text-sm text-ink/60">{t('If one byte changes, or the piece is moved, the tag no longer matches and nothing opens.')}</figcaption>
    </figure>
  );
}
