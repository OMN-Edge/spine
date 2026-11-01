import type { ReactNode } from 'react';
import { helpTopic, HELP_TOPICS } from 'spine-core/help';
import { useI18n } from '../i18n';
import { Actions, P, PageIntro, PublicPage, Section, TextLink, usePublicOptions } from '../components/PublicPage';

/**
 * What happens to a document from the moment it is added, and what a person can do with it after: the long explanation the front page
 * points to. Where the help the assistant gives (core/src/help.ts) already says a thing, the page shows those very paragraphs, translated by
 * the same dictionaries, so the page and the assistant cannot say different things. The rest is said here once; keep it true of the code.
 */
const ASKED = ['password', 'results', 'doctors', 'connections', 'episodes', 'library'];

export default function HowItWorks() {
  const { t } = useI18n();
  const options = usePublicOptions();
  const help = (id: string) => (helpTopic(id)?.paragraphs ?? []).map(p => <P key={p}>{t(p)}</P>);
  const parts = [
    { id: 'adding', title: t('Getting documents in') },
    { id: 'grouping', title: t('Pages that belong together') },
    { id: 'reading', title: t('What is read from each document') },
    { id: 'finding', title: t('Finding things later') },
    { id: 'asking', title: t('Asking your records') },
    { id: 'sharing', title: t('Sharing with a doctor') },
    { id: 'card', title: t('The emergency card') },
    { id: 'languages', title: t('Your language, and taking everything with you') },
    { id: 'questions', title: t('Questions people ask') },
  ];
  const title = (id: string) => parts.find(p => p.id === id)!.title;

  return (
    <PublicPage options={options}>
      <PageIntro title={t('How Spine works')}>
        {t('What happens to a document from the moment you add it, and everything you can do with it after.')}
      </PageIntro>
      {options.billing && (
        <p className="mx-auto max-w-6xl px-4 text-sm text-ink/60 sm:px-6">
          {t('Some of what is described here depends on an account’s plan, such as translation and asking questions:')} <TextLink to="/pricing">{t('Plans and prices')}</TextLink>
        </p>
      )}

      <div className="mx-auto max-w-6xl lg:grid lg:grid-cols-[15rem_1fr] lg:gap-6 lg:px-6">
        <nav aria-label={t('On this page')} className="hidden lg:block">
          <ul className="sticky top-6 mt-14 space-y-2 border-l border-ink/10 pl-4 text-sm">
            {parts.map(p => <li key={p.id}><a href={`#${p.id}`} className="text-ink/65 hover:text-ink">{p.title}</a></li>)}
          </ul>
        </nav>

        <div className="lg:-mx-6">
          <Section id="adding" title={title('adding')}>
            <P>{t('Upload PDFs, Word documents, text files and photos, including those from an iPhone, or a zip of them. Word and text files become PDFs as they arrive. A file you have already added is recognised, and not added twice.')}</P>
            <P>{t('On your phone, Scan photographs paper page by page. The edges of each page are found and it is straightened, and you choose how each page looks, from the photo as taken to clean black and white. The photos as you took them are kept too.')}</P>
            <P>{t('A photo or a scan with no text in it has to be read from the picture: by text recognition on your device, or by an AI model, depending on how the service you use is set up. Your account page lists what is sent where.')}</P>
          </Section>

          <Section id="grouping" title={title('grouping')}>{help('grouping')}</Section>

          <Section id="reading" title={title('reading')}>
            <P>{t('Once you confirm the grouping, each document is read: its title, date and type, the clinic, the doctors it names, its details and its results, each with its unit and the range printed beside it.')}</P>
            <P>{t('Where a file carries its own text, Spine takes it from the file, on your device. Reading the document itself needs an AI model, which gets the text through a relay that does not store or log it.')}</P>
            {help('checking')}
          </Section>

          <Section id="finding" title={title('finding')}>
            <P>{t('The timeline shows every document in order of date. Search finds any word on any page, with or without accents. Each test is charted over time on Trends, against the range printed on the reports, and the doctors your documents name are gathered on a page of their own.')}</P>
            <P>{t('Documents that belong together, such as a consultation and the tests it asked for, are connected, and a stretch of care can be kept together as an episode. Spine suggests both from the documents themselves, and nothing counts until you confirm it.')}</P>
          </Section>

          <Section id="asking" title={title('asking')}>
            <P>{t('Spine has an assistant you can ask about your records, in your own words.')}</P>
            {help('assistant')}
          </Section>

          <Section id="sharing" title={title('sharing')}>
            {help('sharing')}
            <P>{t('The doctor reads what you shared in their own language, and can ask questions about it if you allow that for the link.')}</P>
          </Section>

          <Section id="card" title={title('card')}>
            <P>{t('For each person, write a short card: allergies, medicines, conditions and who to call. Official numbers, such as an insurance number, are kept with it and appear on it only if you tick them.')}</P>
            <P>{t('Turn it on and print it the size of a bank card. Whoever scans its code reads it in their language, with no account. Every opening is recorded and you are told. If the card is lost, make a new code: the old one stops working at once.')}</P>
            <P>{t('A second code holds the card itself as plain text, for a phone with no signal. Anyone who sees that code can read it, and it cannot be turned off.')}</P>
            <P>{t('Once a year, Spine asks you to look at the card again.')}</P>
          </Section>

          <Section id="languages" title={title('languages')}>
            <P>{t('Spine is in English, Romanian, French and German. A document’s details and your notes are translated into the reader’s language when they open it, and the translation is kept.')}</P>
            <P>{t('You can export one document, or everything, as a file that Spine reads back without any AI, on this service or on another.')}</P>
          </Section>

          <Section id="questions" title={title('questions')}>
            <div className="divide-y divide-ink/10 border-y border-ink/10">
              {HELP_TOPICS.filter(topic => ASKED.includes(topic.id)).map(topic => (
                <Question key={topic.id} question={t(topic.question)}>
                  {topic.paragraphs.map(p => <P key={p}>{t(p)}</P>)}
                </Question>
              ))}
            </div>
            <p className="mt-8 leading-relaxed text-ink/70">
              {t('How your records are kept private has a page of its own:')} <TextLink to="/protection">{t('How your records are protected')}</TextLink>
            </p>
          </Section>
        </div>
      </div>

      <section className="border-t border-ink/10">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="max-w-xl font-display text-[clamp(1.7rem,3.2vw,2.4rem)] font-normal leading-tight">{t('See it with invented records first.')}</h2>
          <Actions options={options} className="mt-6" />
        </div>
      </section>
    </PublicPage>
  );
}

function Question({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group py-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
        {question}
        <span aria-hidden="true" className="text-xl text-accent transition-transform group-open:rotate-45">+</span>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
