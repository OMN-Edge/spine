import { helpTopic } from 'spine-core/help';
import { useI18n } from '../i18n';
import { Actions, P, PageIntro, PublicPage, Section, TextLink, usePublicOptions } from '../components/PublicPage';
import { SealingDrawing, WhoCanSee } from '../components/PublicDrawings';

/**
 * How records are protected, said plainly for someone deciding whether to trust Spine with them, and with what it cannot do for them.
 * Every sentence here is one SECURITY.md makes (M-34 to M-38 for the keys and the sealing, M-35 for the relay, M-36 for shares, M-27 and
 * M-33 for signing in, M-49 for the people let in) or one the help text already says (core/src/help.ts, shown as it is). A sentence that
 * names "the server" is checked in `hygiene.test.ts`. The privacy notice is the legal text; this page is not it, and links to it.
 */
export default function Protection() {
  const { t } = useI18n();
  const options = usePublicOptions();
  const help = (id: string, n: number) => <P>{t(helpTopic(id)!.paragraphs[n]!)}</P>;

  return (
    <PublicPage options={options}>
      <PageIntro title={t('How your records are protected')}>
        {t('Where your records are, who can open them, and what nobody, including us, can do for you if you lose your keys.')}
      </PageIntro>

      <div className="mx-auto max-w-6xl px-4 pb-4 pt-6 sm:px-6">
        <SealingDrawing />
        <p className="mt-8 text-ink/70">{t('The algorithms, the levels of keys and what “sealed” means are explained on a page of their own:')} <TextLink to="/encryption">{t('Encryption, in detail')}</TextLink></p>
      </div>

      <Section title={t('Locked on your device')}>
        <P>{t('Your records are read, searched and kept in your browser. The keys that open them are made there, from your password. The server stores them only as sealed pieces it cannot open.')}</P>
        <P>{t('Your master password never leaves your device. The key is made from it there, and to sign you in the server is given only something worked out from it, which does not open your records.')}</P>
        <P>{t('Your browser may keep a copy of the sealed pieces, so your records open faster next time. That copy is as locked as the rest, and signing out removes it.')}</P>
      </Section>

      <Section title={t('Each person, a key of their own')}>
        <P>{t('Every person you keep records for has a key of their own. Someone you let into one person’s records gets that key sealed so that only their own account can open it, and sees nothing else of yours.')}</P>
        <P>{t('When you end someone’s access, the records get a new key, and what the person held before opens nothing. What they already read stays with them: nobody can take back what was seen.')}</P>
      </Section>

      <Section title={t('What the AI sees')}>
        <P>{t('To read and sort documents, their text is sent to an AI model through a relay that does not store or log it. Images of your pages are sent only where image reading has been switched on.')}</P>
        <P>{t('The relay does see the text while it passes through. What it promises is that it keeps none of it, not that it cannot see it.')}</P>
      </Section>

      <Section title={t('Sharing without handing over your keys')}>
        <P>{t('A share link covers what you pick: everything, a tag, a few documents or a date range. It ends when you say, you can revoke it at any time, and the server never holds a key that opens it.')}</P>
        {help('sharing', 2)}
      </Section>

      <Section title={t('Signing in')}>
        <P>{t('You can add a passkey, such as Face ID, a fingerprint or a security key, to sign in and open your records without typing the password, and you can turn on a second step with an authenticator app.')}</P>
        <P>{t('Your account page lists every browser signed in, and you can sign any of them out. Where email is set up, a sign-in from a browser you have not used before is emailed to you.')}</P>
      </Section>

      <Section title={t('If you forget your password')}>
        <P>{t('When you set up your records, you are given a recovery kit. Keep it somewhere safe, away from your devices.')}</P>
        {help('password', 2)}
      </Section>

      <Section title={t('Yours to take, or to delete')}>
        {help('privacy', 2)}
      </Section>

      <section className="mt-6 bg-band text-band-fg">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="max-w-3xl font-display text-[clamp(1.6rem,3vw,2.2rem)] font-normal leading-tight">{t('Who can see what')}</h2>
          <p className="mt-3 text-lg text-band-fg/75">{t('Plainly, with nothing left out.')}</p>
          <div className="mt-8"><WhoCanSee /></div>
        </div>
      </section>

      <Section title={t('Checking it yourself')}>
        <P>{t('Spine is open source. Each build lists a fingerprint of every file it serves, so anyone can check that the app their browser received is the published one.')}</P>
        <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
          <TextLink to="/encryption">{t('Encryption, in detail')}</TextLink>
          <TextLink to="/trust">{t('How to check this app')}</TextLink>
          <TextLink to="/privacy">{t('Privacy notice')}</TextLink>
        </p>
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
