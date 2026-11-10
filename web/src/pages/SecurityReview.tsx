import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Actions, P, PageIntro, PublicPage, Section, TextLink, usePublicOptions } from '../components/PublicPage';

/**
 * How Spine's security was checked, in the shape of an assessment report: who checked it, the method, the standards, what was found, each
 * threat with what stops it and what is left, and what Spine does not protect against. It is docs/threats.md for a reader who is not an
 * engineer; every sentence is one that page or SECURITY.md makes, and the numbers are the review's (S-37 to S-63). It claims no audit and no
 * certificate, and says so first. /source and /security are nginx redirects to the repository.
 */
const External = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline decoration-accent/35 underline-offset-4 hover:decoration-accent">{children}</a>
);

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-ink/10 bg-surface p-5">
      <div className="font-display text-4xl font-normal leading-none">{value}</div>
      <div className="mt-2 text-sm leading-snug text-ink/70">{label}</div>
    </div>
  );
}

function Threat({ title, stops, left }: { title: string; stops: string; left: string }) {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl border border-ink/10 bg-surface p-6">
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mt-3 leading-relaxed text-ink/80">{stops}</p>
      <p className="mt-3 text-sm leading-relaxed text-ink/60"><span className="font-medium text-ink/75">{t('What is left:')}</span> {left}</p>
    </div>
  );
}

export default function SecurityReview() {
  const { t } = useI18n();
  const options = usePublicOptions();

  const steps: Array<[string, string]> = [
    [t('Scope'), t('The whole code (the server, the app that runs in your browser, the relay for AI calls, installation) and the running service.')],
    [t('Threat model'), t('What is protected, who might attack it, and every place where data passes from one party to another: fourteen of them, each with what must hold there.')],
    [t('Checked against a standard'), t('Area by area: cryptography, sign-in and sessions, who may see what, files, the web page, configuration, abuse, the supply chain, the AI features.')],
    [t('Tested'), t('About 180 checks, each with its own verdict. Seven weaknesses were first shown to work as an attack, then shown to be stopped.')],
    [t('The live service'), t('What is really deployed: encryption of the connection, open ports, file permissions, how the services run, and a restore of the latest backup.')],
    [t('Rated'), t('High, Medium or Low, by what an attacker could gain and how hard it is to reach. Without a complete path from an attacker to harm, nothing was counted.')],
    [t('Fixed and tested again'), t('Every fix came with an automated test that fails without it, and that runs on every change from then on.')],
    [t('Reported'), t('This page, and the full record in the code. The security documents were then checked against the code, and about seventy statements that no longer matched it were corrected.')],
  ];

  const threats: Array<[string, string, string]> = [
    [t('Someone gets hold of the server or its backups'),
      t('Your records are sealed on your device under keys made from your password. The server never receives the password and holds no record it can read.'),
      t('A weak master password can be guessed against a stolen copy. Its strength is the protection.')],
    [t('A dishonest server tries to get your keys'),
      t('Your device checks what the server tells it instead of obeying it, keys between people travel through a one-time code, and you compare a short code before you let anyone in.'),
      t('An operator could serve a different app. Anyone can check that the app is the published one.')],
    [t('Someone takes over your account'),
      t('A slow password hash, limits on guessing, an optional second step and passkeys, sign-ins you can see and end. A reset link alone cannot replace your keys, and you are told of every reset.'),
      t('The second step is optional, and malware on your own computer can use a session while it lasts.')],
    [t('Another person on the same service reads your records'),
      t('Each account is kept apart by how the code is built, not by remembering to check. A test signs in as a second person and tries every route.'),
      t('Nothing known.')],
    [t('A share link reaches the wrong person'),
      t('A link opens a sealed copy of only what you chose, its key never reaches the server, it ends when you say, and it can require your approval of each browser.'),
      t('Whoever holds a whole link reads what it shares, and what was seen can be copied.')],
    [t('A document tries to trick the AI'),
      t('The assistant can only read your own records and can change nothing: what it suggests is a card you confirm, worded by the app, not the AI.'),
      t('A hostile document can still steer an answer about itself, which is why every answer links to its source.')],
    [t('A crafted file or a flood of requests'),
      t('Files are recognised by what they are, not their name; huge pages and floods of sign-ups, mail, downloads and AI calls are all capped.'),
      t('Nothing caps all AI calls together except the provider’s own budget.')],
    [t('A poisoned dependency or release'),
      t('Every package is pinned, a build stops on a serious advisory, every change is scanned for secrets and unsafe code, and a release is built and signed by a job that installs nothing.'),
      t('An advisory published after a build is found at the next one.')],
    [t('An unsafe setup'),
      t('The service refuses to start with a weak secret or an unsafe setting, listens only behind its proxy, and keeps its files readable by itself alone.'),
      t('The operator’s own machine is theirs to keep.')],
    [t('Records lost by mistake'),
      t('A daily backup, and anything removed stays in it for a week before it goes. You can export everything at any time.'),
      t('Without both your password and your recovery kit, nobody can open your records, by design.')],
    [t('Your data sent to other companies'),
      t('Every way out is listed and can be switched off; images of your pages need two separate switches; emails never carry medical content.'),
      t('The AI provider sees the text of the calls you choose to make.')],
    [t('An attack nobody notices'),
      t('Sign-ins, failures and security changes are logged without content, and you are emailed about a new browser, a password or second-step change, and a passkey.'),
      t('Watching for unusual activity across accounts is the operator’s.')],
  ];

  return (
    <PublicPage options={options}>
      <PageIntro title={t('How Spine’s security was checked')}>
        {t('Before you trust a service with medical records, ask three things: secure against what, checked how, and by whom. Here are the answers, in the order a security assessment report gives them.')}
      </PageIntro>

      <div className="mx-auto max-w-6xl px-4 pt-2 sm:px-6">
        <div className="max-w-3xl rounded-2xl border border-accent/30 bg-accent/5 p-6">
          <h2 className="text-lg font-medium">{t('Who checked it')}</h2>
          <p className="mt-2 leading-relaxed text-ink/80">{t('The project itself, in November 2026, following the method an independent security assessment uses. It is not an independent audit: no outside firm has tested Spine yet, and no certificate is claimed. Everything below can be checked in the open code and its tests.')}</p>
        </div>
      </div>

      <Section title={t('What it found')} wide>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure value="27" label={t('weaknesses found, every one fixed')} />
          <Figure value="2 · 12 · 13" label={t('High, Medium and Low')} />
          <Figure value="7" label={t('first shown to work as an attack, then shown to be stopped')} />
          <Figure value="180+" label={t('checks, each given a verdict of its own')} />
        </div>
        <div className="mt-8 max-w-2xl">
          <P>{t('The two rated High: a server that lied about an account could have made your device send it your password, or a key made easy to guess; and a password-reset link alone could have replaced your keys. Your device now checks such answers itself, and a reset needs your second step and your recovery kit, and you are told.')}</P>
        </div>
      </Section>

      <Section title={t('The method')} lead={t('The steps any professional assessment follows, and what was done at each.')} wide>
        <ol className="grid gap-4 md:grid-cols-2">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-4 rounded-2xl border border-ink/10 p-5">
              <span className="font-display text-2xl leading-none text-accent">{i + 1}</span>
              <div>
                <h3 className="font-medium">{title}</h3>
                <p className="mt-1 leading-relaxed text-ink/75">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title={t('The standards')} lead={t('Published by OWASP, the open community that sets the reference for web application security.')}>
        <ul className="space-y-4">
          <li><strong>{t('Application Security Verification Standard 5.0')}</strong>: {t('the checklist of security requirements for web applications. Its chapters set the areas of the review. Its requirements were not gone through one by one, so no level is claimed.')}</li>
          <li><strong>{t('Top 10:2025')}</strong>: {t('the ten most common kinds of web application risk. Each threat below falls under one.')}</li>
          <li><strong>{t('Top 10 for LLM Applications 2025')}</strong>: {t('the same for software that uses AI models: hidden instructions in documents, an AI given too much power, costs that run away.')}</li>
          <li><strong>{t('Web Security Testing Guide 4.2')}</strong>: {t('how to test each area.')}</li>
        </ul>
      </Section>

      <Section title={t('The threats, and what stops each one')} wide>
        <div className="grid gap-4 md:grid-cols-2">
          {threats.map(([title, stops, left]) => <Threat key={title} title={title} stops={stops} left={left} />)}
        </div>
      </Section>

      <section className="bg-band text-band-fg">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="max-w-3xl font-display text-[clamp(1.6rem,3vw,2.2rem)] font-normal leading-tight">{t('What Spine does not protect against')}</h2>
          <p className="mt-3 text-lg text-band-fg/75">{t('A security claim is only as honest as its limits.')}</p>
          <ul className="mt-8 grid max-w-4xl gap-4 sm:grid-cols-2">
            <li>{t('Malware on your own computer or phone, which can read your records while they are open.')}</li>
            <li>{t('A weak or reused master password: it is the key to everything.')}</li>
            <li>{t('An operator who serves a different app, unless someone checks the app against the published code.')}</li>
            <li>{t('What a recipient has already seen: ending a link stops new reads, not copies.')}</li>
            <li>{t('The AI provider, which sees the text of each call while it runs it. The relay keeps none of it, but it does see it.')}</li>
            <li>{t('Whoever runs the machine, who can stop or delete the service, though not read your records on its disk.')}</li>
          </ul>
        </div>
      </section>

      <Section title={t('What comes next')}>
        <P>{t('An outside firm brings what a project cannot give itself: people with no stake in the result. For Spine that means a penetration test of a running service, a review of the encryption by a specialist, and a retest, ending in a letter that says what was tested and what remained. Its report will be published here.')}</P>
        <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
          <External href="/security">{t('The full security record')}</External>
          <External href="/source">{t('Open the code')}</External>
          <TextLink to="/protection">{t('How your records are protected')}</TextLink>
          <TextLink to="/trust">{t('How to check this app')}</TextLink>
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
