# Privacy notice

{{operator}} ("we") is the controller of the personal data in your Spine account. Contact for anything about your data, including the requests below: {{contact}}.

## How Spine keeps your records

Your records are read, organised and searched on your own device, in your browser. Before anything is saved to our servers it is encrypted on your device with keys that we do not have: they come from your master password (which never leaves your device), from the recovery kit you are given at sign-up, or from a passkey you chose to use. What we hold is encrypted, and we cannot open it. This also means that **if you lose both your master password and your recovery kit, nobody, including us, can get your records back.** This design has not yet been independently audited.

## What we process, and why

| What | Why | On what basis |
| --- | --- | --- |
| Your email address, and a value your device derives from your password, which we store as a slow hash (we never receive your password) | To make and secure your account and to send you account messages | Contract (Art. 6(1)(b) GDPR) |
| Which versions of this notice and the terms you agreed to, and when | To show that you agreed | Legal obligation; our legitimate interest in being able to show it |
| The encrypted objects your device saves: your documents and what is read from them (dates, providers, names, values, summaries), your notes and tags, and your conversations with the assistant. We see only that they exist, how many there are, how large, when they changed and a coarse kind (for example "file" or "changes") | To store your records and let you open them on your devices | Your explicit consent to the use of your health data (Art. 9(2)(a)); you give it separately from accepting the terms and can withdraw it at any time by deleting your account |
| For each share link you make: an encrypted copy of what you chose to share, when it ends, and a record of each time it was opened (time, the country worked out from the address, and which document was opened; the address itself is not kept). If you require approval: the request a visitor sends (the country and the short note they typed, up to 120 characters) | To let someone you choose read what you shared, and so you can see who opened it | Contract; our legitimate interest in security |
| Sign-in records (time, browser, address), kept while the sign-in is valid (at most 14 days) | To protect your account and show you where it is signed in | Our legitimate interest in security |
| Your plan, if the service has plans: which one, when it renews or ends, the payment provider's identifiers for your customer and subscription, and how much AI reading you have used in the period (a number, never what was read) | To give you the plan you chose and keep within its limits | Contract |
| If you ask to be told when Spine opens: your email address and the day | To write to you once, when it opens | Your consent (Art. 6(1)(a)); ask us and we remove it |
| Counts with nothing that identifies anyone: how many accounts were made, how many came from a shared page, a doctor's page or an invitation, how many shared pages were opened, how many checkouts were started | To see whether the service works and what it costs | Our legitimate interest in running the service |
| Server logs (time, the address asked for, source address, outcome, and for a sign-in the account and the browser), never your records or your password; counters that limit abuse; for model calls, how many a day your account and each share made | To run and protect the service | Our legitimate interest in security |

We do not sell your data, use it for advertising or use it to train models. We make no decision about you by automated means.

## Who else sees it

- **Hosting.** The encrypted objects, and your account data, are kept on infrastructure we run or rent in the European Union. We cannot read the objects.
- **The relay and AI models.** When a feature uses a model (reading a scan that has no text, extracting details, summarising, translating, answering your questions, finding documents that belong together), your device sends the text, or for a scan the page image, that the feature needs to a small service we run, the relay, which passes it to the model provider this service is set up with, for that request only, at an endpoint in the European Union, under terms that do not allow the provider to keep it or train on it. The relay can see what passes through it while it handles the request; it does not store it and does not write it to its logs, which hold only the feature, the model, the outcome, the size and the time. You can see which features do this on your account page; some are switched off by default.
- **Email.** Account messages (verifying an address, a reset link, a notice of a sign-in from a new browser, a notice that a password or second-factor setting changed, a notice that someone is waiting for your approval of a share) go through an email provider. They never contain a document or a result.
- **Payments.** If you buy a paid plan, Paddle sells it to you as the seller of record: it receives what you type on its payment page (such as your email address, name, billing address and card), keeps its own records of the purchase and issues the invoice. We receive which plan you have, when it renews or ends, and Paddle's identifiers for your customer and subscription. We never see your card. Paddle's own privacy notice governs what it holds.
- **People you share with.** A share link shows what you chose to whoever opens it. Whoever holds the whole link can read that copy; with approval switched on, a link alone opens nothing.
- Authorities, only where the law requires it.

## The demo

Where this service offers it, the demo lets someone try Spine without an account. It opens with invented records in your own browser, and nothing of it reaches us. If you also add files of your own, which the operator may allow, you are asked first to agree to the health data in them being processed to try Spine (Art. 9(2)(a) GDPR). They are read as described above: through the relay, which does not store or log what it carries, by the model provider, for that request only. The demo keeps your files only in that page; we keep no record of them and make no account. To count the model calls the demo may make, the relay is told a value derived from your address with a key, from which the address cannot be read, and counts that value's calls for the day. If you choose to keep your files in an account, your browser holds them, unencrypted, until you add them to the account or discard them, and for one day at most.

## Cookies and what the browser keeps

We use no advertising or tracking cookies and nothing from third parties. The browser keeps only what the service needs or what you chose:

- A **sign-in cookie**, so that you stay signed in, ended when you sign out or when the sign-in expires.
- A **browser cookie** (one year) that lets us tell a browser you have signed in from before from a new one, so we can tell you about a new one.
- On your device: the **language** you chose, the conversation you had open in the assistant and the doctors you dismissed from a suggestion list, so that the screens remember them; the documents you changed on the regrouping screen and have not yet had read again (their ids, no text), and, for someone opening a share link that needs approval, the key pair made for that request; these last two are forgotten when the tab is closed.
- On your device: a **copy of your encrypted objects**, exactly as they are held on our servers and no more readable than there (it holds no record's text and no key), kept so that opening your records after a reload does not download them again. It stays in the browser until you sign out or delete your account, when it is removed; if you close the browser without signing out it stays until you next sign out, so on a browser you share, sign out.

## How long, and how safe

Records stay until you delete them or your account. Deleting the account removes your keys, your encrypted objects, your shares and the copy of your encrypted objects in our backups; the daily backups of the accounts database made before that still hold your account's row until they are replaced, which is a matter of days. Sign-in records are kept as described above, and server logs for as long as needed for security and no longer than twelve months.

Your device encrypts your records before they leave it; the connection is encrypted; your password is never sent to us; sign-ins can be protected with a second factor or a passkey; share links expire and can be revoked, and a copy is encrypted under a key that is only in the link.

## Your rights

You can ask us for a copy of your data, to correct it, to delete it, to limit or object to its processing, and to receive it in a machine-readable form. Because we cannot open your records, you do most of this yourself, and at once: the account page lets you **export everything** and **delete your account**, and you can correct anything in the app. For the data we can see (your email, your consent records, your sign-in records) write to us. You can withdraw your consent at any time (withdrawing ends the use of your health data, so it means deleting the account); this does not affect what was done before. You can complain to the supervisory authority: in Romania the ANSPDCP (www.dataprotection.ro), or the one where you live.

## Children

An account for a child is managed by a parent or guardian. A young person under 16 needs their guardian's consent.

## Changes

If this notice changes in a way that matters, you are told and asked again.
