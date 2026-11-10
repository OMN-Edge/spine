import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Actions, P, PageIntro, PublicPage, Section, TextLink, usePublicOptions } from '../components/PublicPage';

/**
 * How Spine's security was checked, in the shape of an assessment report: who checked it, the named attacks Spine is built to resist
 * (each with its CWE or OWASP reference and what stops it), the method, the standards, and what it does not protect against. It is
 * docs/threats.md for a reader who is not an engineer; every line is a control SECURITY.md describes. It claims no audit
 * and no certificate, and says so first. /source and /security are nginx redirects to the repository.
 */
const External = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline decoration-accent/35 underline-offset-4 hover:decoration-accent">{children}</a>
);

type Attack = [name: string, reference: string, stops: string];

function Group({ title, attacks }: { title: string; attacks: Attack[] }) {
  return (
    <div className="rounded-2xl border border-ink/10 bg-surface p-6">
      <h3 className="text-lg font-medium">{title}</h3>
      <dl className="mt-4 space-y-4">
        {attacks.map(([name, reference, stops]) => (
          <div key={name}>
            <dt className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{name}</span>
              <span className="font-mono text-xs text-ink/50">{reference}</span>
            </dt>
            <dd className="mt-1 leading-relaxed text-ink/75">{stops}</dd>
          </div>
        ))}
      </dl>
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
    [t('Tested'), t('About 180 checks, each with its own verdict. Where an attack looked possible, it was written as an automated test and run against the code.')],
    [t('The live service'), t('What is really deployed: encryption of the connection, open ports, file permissions, how the services run, and a restore of the latest backup.')],
    [t('Rated'), t('High, Medium or Low, by what an attacker could gain and how hard it is to reach.')],
    [t('Tested on every change'), t('Every fix, and the protections the code holds, have automated tests that fail if the protection is taken away; they run on every change. The settings of the web server and the host were checked on the running service.')],
    [t('Reported'), t('This page, and the full record in the code. The security documents were then checked against the code, and about seventy statements that no longer matched it were corrected.')],
  ];

  const groups: Array<[string, Attack[]]> = [
    [t('On the connection and the page'), [
      [t('Man-in-the-middle and TLS stripping'), 'CWE-319', t('Only HTTPS, with TLS 1.2 or 1.3, and strict transport security, so a browser that has visited never falls back to plain HTTP.')],
      [t('Cross-site scripting (XSS)'), 'CWE-79', t('A strict content security policy runs only the app’s own scripts, and text from documents or the AI is shown as text, never as page code.')],
      [t('Clickjacking'), 'CWE-1021', t('The app refuses to be shown inside another site’s frame.')],
      [t('Cross-site request forgery (CSRF)'), 'CWE-352', t('The sign-in cookie is never sent by another site, and a request that changes something must come from the app’s own address.')],
      [t('Tampered app code'), 'CWE-494', t('The page’s scripts carry integrity hashes, and every file’s fingerprint is published, so anyone can compare the app with the open code.')],
    ]],
    [t('At sign-in'), [
      [t('Credential stuffing and password spraying'), 'CWE-307', t('Limits per source and across the whole service, a slow password hash, and common or patterned passwords refused.')],
      [t('Account enumeration'), 'CWE-204', t('Sign-in, sign-up and password reset answer the same, in the same time, whether an address has an account or not.')],
      [t('Two-factor brute force and code replay'), 'CWE-307 · CWE-294', t('Five tries per account in ten minutes, and a code once used is never accepted again.')],
      [t('Session hijacking and session fixation'), 'CWE-613 · CWE-384', t('A cookie scripts cannot read, a new session at every sign-in, short lifetimes, and every signed-in browser listed for you to end.')],
      [t('Password-reset takeover and reset poisoning'), 'CWE-640', t('Reset links are used once, built from the service’s own address, and cannot replace your keys without your second step and your recovery kit.')],
      [t('Rate-limit evasion by IP spoofing'), 'CWE-348', t('The client’s address is taken only from the service’s own proxy, so a forged header cannot reset a limit.')],
    ]],
    [t('Between accounts and share links'), [
      [t('Insecure direct object reference (IDOR)'), 'CWE-639', t('Every lookup is tied to the signed-in account by how the code is built, and a test tries every route as a second user.')],
      [t('Share-link overreach'), 'CWE-285', t('A link opens a sealed copy of only what it covers; anything else does not exist for it.')],
      [t('Approval spoofing'), 'CWE-290', t('Before you approve a browser or let someone into your records, you compare a short code with them, so a request made up by someone else is told apart.')],
    ]],
    [t('In the encryption'), [
      [t('Offline cracking of a stolen database'), 'CWE-916', t('Records are encrypted with keys the server never has, and passwords and recovery codes are stored with slow, salted hashes.')],
      [t('Key substitution by a dishonest server'), 'CWE-322', t('Keys between people travel through a one-time code, so the server cannot slip in a key of its own.')],
      [t('Downgrade attack'), 'CWE-757', t('Your device refuses key settings weaker than a fixed floor or than it saw before, whatever the server says.')],
      [t('Ciphertext swapping'), 'CWE-345', t('Each sealed piece is bound to its own name and kind, so it will not open if it is moved elsewhere.')],
      [t('Rollback to an older state'), t('noticed'), t('Your device tells you when the records it is shown are older than the last it saw.')],
    ]],
    [t('In what you upload, and in the AI'), [
      [t('SQL injection and command injection'), 'CWE-89 · CWE-78', t('Every query takes values as data, never as code, and the server runs no program on your files.')],
      [t('Path traversal and Zip Slip'), 'CWE-22', t('Entries in a zip are read by name and never written to a place the archive chooses.')],
      [t('Decompression bombs and image bombs'), 'CWE-409', t('Page counts, image sizes and unpacked sizes are capped before anything is drawn or unpacked.')],
      [t('Server-side request forgery (SSRF)'), 'CWE-918', t('The server never fetches an address a user supplies.')],
      [t('Prompt injection'), 'OWASP LLM01', t('The assistant can only read and propose, so instructions hidden in a document cannot make it change or send anything.')],
      [t('Data exfiltration through AI output'), 'OWASP LLM05', t('The page shows no image or link the AI makes up, and can talk only to Spine and its relay.')],
    ]],
    [t('Against abuse and the supply chain'), [
      [t('Denial of service and denial of wallet'), 'CWE-400 · OWASP LLM10', t('Uploads, downloads, sign-ups and AI calls are all capped, per person and for the whole service.')],
      [t('Email bombing'), 'CWE-770', t('Mail to any one address, and mail in total, is limited.')],
      [t('Algorithmic complexity attack'), 'CWE-407', t('Rate limiting stays fast however many addresses an attacker uses.')],
      [t('Compromised dependency'), 'CWE-1395', t('Every package is pinned, and a build stops on a serious advisory.')],
      [t('Poisoned build pipeline'), 'CWE-829', t('Pipeline steps are pinned by their exact version, and releases are signed by a job that installs nothing.')],
      [t('Hard-coded and default secrets'), 'CWE-798', t('Every change is scanned for secrets, and the service will not start with a weak or published one.')],
      [t('Sensitive data in logs'), 'CWE-532', t('Logs never hold record content or passwords.')],
      [t('Loose file permissions'), 'CWE-732', t('Every file the service writes is readable by its own user alone.')],
    ]],
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

      <Section title={t('The attacks it is built to resist')} lead={t('Named as security professionals name them, each with its reference in the Common Weakness Enumeration (CWE) or the OWASP lists, and what stops it.')} wide>
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map(([title, attacks]) => <Group key={title} title={title} attacks={attacks} />)}
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
          <li><strong>{t('Top 10:2025')}</strong>: {t('the ten most common kinds of web application risk.')}</li>
          <li><strong>{t('Top 10 for LLM Applications 2025')}</strong>: {t('the same for software that uses AI models: hidden instructions in documents, an AI given too much power, costs that run away.')}</li>
          <li><strong>{t('Web Security Testing Guide 4.2')}</strong>: {t('how to test each area.')}</li>
        </ul>
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
