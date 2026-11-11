import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Actions, PageIntro, PublicPage, Section, TextLink, usePublicOptions } from '../components/PublicPage';

/**
 * How Spine is kept secure as it changes: the named attacks it is built to resist (each with its CWE or OWASP reference and what stops
 * it), the automated checks on every change (.github/workflows/ci.yml), the review before every release (docs/releasing.md), what a
 * release carries (release.yml), the standards, and what it does not protect against. It is docs/threats.md for a reader who is not an
 * engineer; every line is a control SECURITY.md describes or a step those files run. /source and /security are nginx redirects to the
 * repository.
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

function Stage({ n, title, lead, items }: { n: number; title: string; lead: string; items: Array<[string, string]> }) {
  return (
    <div className="rounded-2xl border border-ink/10 p-6">
      <div className="flex items-baseline gap-3">
        <span className="font-display text-3xl leading-none text-accent">{n}</span>
        <h3 className="text-xl font-medium">{title}</h3>
      </div>
      <p className="mt-2 leading-relaxed text-ink/70">{lead}</p>
      <ul className="mt-4 space-y-3">
        {items.map(([name, body]) => (
          <li key={name} className="leading-relaxed text-ink/80"><span className="font-medium text-ink">{name}.</span> {body}</li>
        ))}
      </ul>
    </div>
  );
}

export default function SecurityChecks() {
  const { t } = useI18n();
  const options = usePublicOptions();

  const everyChange: Array<[string, string]> = [
    [t('Security tests'), t('A second user tries every route, and sign-in, sessions, sharing, the encryption and the assistant each have tests that fail if a protection is taken away.')],
    [t('Dependency audit'), t('A known serious vulnerability in any package stops the build.')],
    [t('Secret scanning'), t('The whole history of the code is searched for keys and passwords.')],
    [t('Static analysis'), t('The code is scanned for unsafe patterns.')],
    [t('Real browsers'), t('The whole app runs in Chrome against a real server, and the server’s files are searched for any record that could be read.')],
    [t('Reproducible build'), t('The app is built twice, and the two must come out identical.')],
  ];
  const beforeRelease: Array<[string, string]> = [
    [t('What changed'), t('Every route, setting, table, dependency and path out of the service the release adds or changes.')],
    [t('Threat model'), t('Anything new to protect, anyone new who might attack it, and every new place where data passes from one party to another.')],
    [t('Checked against the standards'), t('Each area the change touches, against the OWASP checklists, with a verdict written down for each.')],
    [t('Fixed with a test'), t('Whatever the review turns up is fixed before the release, with a test that fails without the fix.')],
    [t('Documents kept true'), t('What the security documents, the privacy notice and the screens say is checked against the code.')],
    [t('The live service'), t('After it is deployed: the encryption of the connection, open ports, file permissions and backups, checked on the running service.')],
  ];
  const atRelease: Array<[string, string]> = [
    [t('Built in the open'), t('A release is built by GitHub from the published code, not on anyone’s own computer, and every check runs again first.')],
    [t('Signed'), t('Its files carry a signed record of the exact code they were built from.')],
    [t('Verifiable'), t('Anyone can compare the app a site serves with the published release, file by file.')],
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
      <PageIntro title={t('Checked on every change, reviewed before every release')}>
        {t('Security is not a check Spine passes once a year. It is part of how Spine is built and shipped, what the industry calls a secure development lifecycle: automated security checks on every change, a security review before every release, and a release anyone can verify.')}
      </PageIntro>

      <Section title={t('The attacks it is built to resist')} lead={t('Named as security professionals name them, each with its reference in the Common Weakness Enumeration (CWE) or the OWASP lists, and what stops it.')} wide>
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map(([title, attacks]) => <Group key={title} title={title} attacks={attacks} />)}
        </div>
      </Section>

      <Section title={t('How it stays that way')} lead={t('Three stages every version of Spine goes through.')} wide>
        <div className="grid gap-4 lg:grid-cols-3">
          <Stage n={1} title={t('On every change')} lead={t('Automated, on every proposed change and every change to the main code.')} items={everyChange} />
          <Stage n={2} title={t('Before every release')} lead={t('A security review of everything that changed since the last release. No release is made without it.')} items={beforeRelease} />
          <Stage n={3} title={t('At release')} lead={t('What a release carries, so you do not have to take it on trust.')} items={atRelease} />
        </div>
      </Section>

      <Section title={t('The standards')} lead={t('Published by OWASP, the open community that sets the reference for web application security.')}>
        <ul className="space-y-4">
          <li><strong>{t('Application Security Verification Standard 5.0')}</strong>: {t('the checklist of security requirements for web applications. A release review goes through its chapters for every area a change touches. Its requirements are not all checked one by one, so no level is claimed.')}</li>
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

      <Section title={t('See for yourself')}>
        <p className="flex flex-wrap gap-x-6 gap-y-2">
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
