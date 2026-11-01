import { useI18n } from '../i18n';
import { Actions, P, PageIntro, PublicPage, Section, TextLink, usePublicOptions } from '../components/PublicPage';
import { FamilySpines } from '../components/PublicDrawings';

/**
 * Spine for the people who look after others: a child, a parent, a partner. Every sentence is one SECURITY.md makes (M-48 for people,
 * M-49 for letting others in, M-50 for children and sixteen, M-51 for eighteen, M-47 for the card) or a scenario holds (docs/scenarios.md,
 * section 15); keep it true of the code. Ages are the page's rule: the server cannot know them, so nothing here says it checks them.
 */
export default function Families() {
  const { t } = useI18n();
  const options = usePublicOptions();

  return (
    <PublicPage options={options}>
      <PageIntro title={t('Spine for families')}>
        {t('Most people who keep medical papers keep them for someone else too: a child, a parent, a partner. Spine keeps each person’s records apart, and lets you share the looking-after.')}
      </PageIntro>

      <figure className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl"><FamilySpines /></div>
        <figcaption className="mt-2 max-w-2xl text-sm text-ink/60">{t('Each document is a vertebra on one person’s spine, and each person’s records are kept apart.')}</figcaption>
      </figure>

      <Section title={t('One account, several people')}>
        <P>{t('Add a person and their records start empty, with their own documents, search, share links and emergency card. Switch between them without typing your password again.')}</P>
        {options.billing && <P>{t('How many people an account can keep depends on its plan.')}</P>}
      </Section>

      <Section title={t('A child’s records')} wide>
        <div className="max-w-2xl">
          <P>{t('Mark a person as a child you look after and give their birth date. It is sealed with their records, and Spine uses it only to know their age: whether they can have an account of their own yet, and when the records should become theirs.')}</P>
        </div>
        <AgeLine stops={[
          { age: t('From birth'), text: t('You keep the records, and can let the other parent in.') },
          { age: t('From sixteen'), text: t('They can have an account of their own, at your invitation.') },
          { age: t('At eighteen'), text: t('They can take the records into their own account.') },
        ]} />
      </Section>

      <Section title={t('Looking after them together')}>
        <P>{t('Let the other parent in with a code, as someone who can change the records, or let a grandparent only read them. They use their own account and see only that child’s records, never yours.')}</P>
        <P>{t('You can pause their access, or end it. Ending it gives the records a new key.')}</P>
        <P>{t('If you delete your account, everyone you let in loses the records too. Spine says so before you delete it.')}</P>
      </Section>

      <Section title={t('From sixteen')}>
        <P>{t('From sixteen, you can invite your child in as themselves, with an account of their own. Your invitation is your consent. They see their records as you do and can add to them.')}</P>
        <P>{t('Until eighteen, nothing is hidden from the people who look after them.')}</P>
      </Section>

      <Section title={t('At eighteen')}>
        <P>{t('At eighteen the records should be theirs. When they choose, they take them into their own account, under a new key. It cannot be undone, and only they can do it.')}</P>
        <P>{t('The people who looked after them are paused, and they decide, one by one, who comes back in. An emergency card you made for them goes with them, and its printed code keeps working.')}</P>
        <P>{t('If they have no account yet, the records stay with you until you invite them.')}</P>
      </Section>

      <Section title={t('A card, and a doctor, for each of them')}>
        <P>{t('Each person can have their own emergency card: allergies, medicines and who to call, for a school nurse or someone looking after them for the day.')}</P>
        <P>{t('Open a child’s records and share them as you would your own: their doctor sees only what you choose, for as long as you choose.')}</P>
        <p className="mt-6"><TextLink to="/how-it-works#card">{t('How the emergency card works')}</TextLink></p>
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

/** A child's records across the ages that change who holds them: a sequence by age, so it is drawn as a line with its stops in order. */
function AgeLine({ stops }: { stops: Array<{ age: string; text: string }> }) {
  return (
    <ol className="relative mt-10 grid gap-8 md:grid-cols-3 md:gap-6">
      <span aria-hidden="true" className="absolute left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent/25 md:left-0 md:right-0 md:top-[7px] md:bottom-auto md:h-0.5 md:w-auto" />
      {stops.map((stop, i) => (
        <li key={stop.age} className="relative pl-8 md:pl-0 md:pt-8">
          <span aria-hidden="true" className={`absolute left-0 top-1 h-4 w-4 rounded-full border-2 border-accent md:top-0 ${i === stops.length - 1 ? 'bg-accent' : 'bg-paper'}`} />
          <p className="font-display text-xl">{stop.age}</p>
          <p className="mt-1 max-w-xs leading-relaxed text-ink/75">{stop.text}</p>
        </li>
      ))}
    </ol>
  );
}

