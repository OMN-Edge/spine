# Spine's own e-Factura link

`SPINE_INVOICING=efactura` makes the operator's invoices without a service between Spine and ANAF: Spine numbers the invoice in the operator's series, writes it as the e-Factura XML, keeps it, sends it to ANAF with the operator's authorisation, asks ANAF what it decided and keeps the signed answer. The other choice is Billyou (`SPINE_INVOICING=billyou`, docs/billing.md, "Invoices when the provider is not the seller"). Both sit behind the same interface (`InvoiceIssuer`, `packages/billing/src/invoicing/issuer.ts`), so the queue, the webhook, the refund storno and the operator's tools are the same for either.

The code is a workspace package, `packages/anaf/` (`spine-anaf`), with one door (`index.ts`) that a check holds (S15). It asks the rest of Spine for the eight store methods named in its `AnafStore` and for the settings in `AnafConfig`, and for nothing else of Spine's, so it can be run as a service of its own by giving it a small HTTP face (issue, status, PDF) without rewriting any of it. What is Spine's stays outside: `packages/billing/src/invoicing/efactura.ts` gives it the National Bank's rate and the path a PDF is served at, and turns its `AnafError` into the `InvoiceError` the queue decides by.

## What each file is

| File | What it does |
|---|---|
| `ubl.ts` | The XML: UBL 2.1 in CIUS-RO 1.0.1, an Invoice or a CreditNote. Pure, in whole cents. |
| `anaf.ts` | The authorisation (sign-in URL, the exchange of the code, refreshing the tokens) and the calls: validare (ANAF's own check of a file before it is sent), upload, uploadb2c, stareMesaj, descarcare; and the Ministry's PDF converter. |
| `issuer.ts` | The numbered documents and what ANAF is told about each; the signed links to a PDF. |
| `seal.ts` | AES-256-GCM, under a key that is in the environment and never in the database. |
| `zip.ts` | Reads ANAF's answer (a zip of the invoice and the Ministry's signature). |
| `index.ts` | `makeEfactura`: puts them together from the settings. |

## How an invoice goes

1. A payment reaches the queue (`invoice_queue`) as for any issuer. `issue` reserves the next number of the series for the payment (`efacturaReserve`, one transaction, so no number is given twice or lost), writes the XML and keeps it with what it was made from (`efactura_documents`). It only touches the database, so asking again for the same payment returns the same invoice.
2. `sendToAnaf` uploads it. A buyer in Romania with a tax number is a business (`upload`, B2B); a person is `uploadb2c`, which ANAF requires for sales to people since 31.03.2025 (the Ministry's technical page), identified by thirteen zeros where no CNP was given, as ANAF's test platform accepts. A buyer abroad is not sent: e-Factura is for Romania (the account's invoice history has the document).
3. ANAF decides within seconds to hours. The queue asks every five minutes for up to a day (`stareMesaj`); on `ok` the signed answer is downloaded and kept (ANAF has it for 60 days only), on `nok` its errors are downloaded and shown in `/admin`. The operator's "Try again" makes the XML again from what it was made from (in case the writer was mended) and sends it as new.
4. A refund makes a credit note (381, `standard=CN`) numbered in the same series, naming the invoice.
5. The PDF is the Ministry's own converter's, made from the same XML (`transformare`, public); the account's invoice history opens it at a signed link that lasts ten minutes.

**The seller is not a VAT payer** (the accountant's word, to be confirmed): the class is "not subject to VAT" (`O`), the invoice carries no VAT identifier for anyone (BR-O-02), and the seller is named by its registration number alone (BR-CO-26). A VAT payer sets `SPINE_SELLER_VAT_ID` and a rate.

## The authorisation, and what the operator does

ANAF identifies the person who signed in with the qualified certificate, not the application (`oauth-procedura-inregistrare-aplicatii.txt`): the tokens are for the certificate's serial, and the certificate must be registered in SPV with a right for the company (legal representative, designated representative or authorised person).

Once, by the operator:

1. Have the certificate registered in SPV for the company.
2. At `www.anaf.ro/InregOauth` (Servicii Online, Inregistrare utilizatori, Dezvoltatori aplicatii, Inregistrare pentru API-uri) create the developer account, then register the application: a name, the callback `https://<domain>/api/admin/efactura/callback` (it must be `https`, and the same as `SPINE_EFACTURA_REDIRECT_URI`), the service E-Factura. ANAF gives a client id and a client secret.
3. Put them in the environment (`ANAF_CLIENT_ID`, `ANAF_CLIENT_SECRET`), with `SPINE_EFACTURA_KEY` (`openssl rand -base64 32`), the seller's data and `SPINE_EFACTURA_MODE=test`.
4. In `/admin/invoices`, "e-Factura": **Sign in to ANAF with the certificate**. The browser goes to ANAF, asks for the certificate (the USB token plugged in, or its software running), and comes back; Spine exchanges the code within the 60 seconds ANAF allows.
5. **Test the connection** (shown once authorised) calls ANAF's own `TestOauth` service (`api.anaf.ro/TestOauth/jaxrs/hello`, in the OAuth procedure): it takes nothing for e-Factura and answers 200 if ANAF accepts the token, and says whether it saw a certificate with it. A 403 there means the token is not accepted, which for a certificate that signs in fine is usually a certificate with no SPV right for the company. What the service echoes (the token, the certificate's serial) is not kept or shown.

After that no certificate is needed until the refresh token ends (a year): the access token (90 days) is refreshed by itself when it has less than two weeks left, ANAF giving a new pair each time. `/admin` shows when each ends and whether a refresh is due; if the access token cannot be refreshed it keeps being used while it is good, and an invoice waits for the operator rather than failing when there is no authorisation at all.

`test` is ANAF's test platform (`api.anaf.ro/test/FCTEL/rest`): the same sign-in and the same certificate, files that are checked as real ones and registered nowhere. Move to `prod` only after the invoices the test platform takes are the ones the accountant approves.

## What is kept, and what protects it

- `efactura_auth`: the access and refresh tokens, sealed (`seal.ts`). Reading the database gives nothing without `SPINE_EFACTURA_KEY`; both secrets are stripped from the relay's environment.
- `efactura_documents`: each invoice and credit note, its XML, ANAF's index and state, and the signed answer. **Kept after an account is deleted**: an invoice is a fiscal record (ten years), and the buyer's name and address are in it. The privacy notice says so (`docs/legal/privacy.md`).
- `efactura_series`: the next number of each series. `efactura_pending`: the authorisation being asked for.
- The callback is reachable by ANAF's redirect, which carries no session (the cookie is `SameSite=strict`), so it trusts one thing: the one-time `state` that a signed-in administrator with a recently typed password asked for, ten minutes long, spent on first use, and not spent by a wrong guess.
- The PDF link is signed with a key made from the sealing key, for one document and ten minutes.

## What is known, and what is not

Read from ANAF's own papers (`docs/reference/efactura/`, fetched 2026-11-16): the OAuth flow and lifetimes, the four calls and their parameters, the limits (1000 a minute; a message may be asked about 100 times and downloaded 10 times a day), the status words, the Schematron 1.0.9 and the two examples. The XML is checked in the tests against the OASIS UBL 2.1 schemas (`xmllint`, where it is installed); **the Schematron itself is not run here** (it needs XSLT 2 and Java): ANAF's test platform is the check, and it is the first thing to do with a real authorisation.

Not confirmed by running it:

- That ANAF accepts these files: the first upload to the test platform is the proof. Its error messages are kept and shown, and an upload can be tried again after the writer is mended.
- Whether the authorisation URL takes a `state` (the reference flow leaves it empty). Spine sends one and refuses a callback without it; if ANAF's sign-in drops it, that check needs another bearer.
- ANAF's check before the upload (`validare/FACT1` or `FCN`): its API presentation documents the production address only, so it is asked there in either mode, with the same token. A file is held back only on ANAF's clear word (`stare` `nok`, with its messages, kept as the document's message); an answer that cannot be had or read lets the upload go on, since the upload says the same. The answer's shape (`stare`, `Messages[].message`) is read from another library's code and has not been seen here.
- The upload's content type: ANAF's own swagger says any, and its converter's says `text/plain`, which is what is sent.
- The refresh round trip with real tokens (ANAF documents it; nothing here has run it).
- Where a person's identifier goes in the XML (`PartyIdentification`, thirteen zeros) and the exemption wording for the class `O`: the accountant's and ANAF's test.
- A partial refund still needs a credit note by hand (a storno is the whole invoice), and VAT is one rate for everyone, as with Billyou.
- No mail to the buyer: the invoice is in the account's history and, for a business, in its SPV.

Left out of the repository for size, and kept with the session's notes: ANAF's offline validators (`roefacturavalidator_12122024.zip`, `verifstandalone.zip`) and the XML-to-PDF applications (`GenerareFactura.zip`), all from `https://mfinante.gov.ro/ro/web/efactura/informatii-tehnice`.
