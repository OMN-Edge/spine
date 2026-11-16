# Packages: what is reused beyond Spine

Spine's accounts, billing and invoicing are wanted by other applications, and the ANAF link by other companies. This page says what is a package, what stays in Spine, what each may import, and in what order they are made. It is a design, and each step in the last section says what is built; a name in backticks is in the repository, and what is not yet built is named in words.

## What is reused, and how

| Part | How | Why this and not the other |
|---|---|---|
| **ANAF** (the OAuth link, e-Factura, later the company lookup and e-Transport) | A folder with one door now, then a package, and later a service that runs it | It is the one part that is sold to others: it has no user, vault or plan in it, and a company's invoices are its own business. |
| **Billing** (providers, the events, subscriptions, withdrawals, the invoicing queue, the product catalog) | A package that an application embeds, with its own tables | The same business stands behind every application (one seller, one payment account), and the part that costs most to write is what surrounds the checkout, not the checkout. |
| **Identity** (accounts, sign-in, sessions, second factors, passkeys, one-time tokens) | A folder inside Spine with one door, and not a package | What Spine's sign-in is for (the password makes the vault's key, a reset is proved against the vault, a device is let in by another) is not generic, and what is left is what a library or a provider already does. A second application decides it; until then the boundary is kept by a check. |
| **Admin** | Stays where it is | It has no data of its own: it reads the accounts and billing stores behind the same session. A host of its own would need a second sign-in and a copy of the data. Its routes become a thin layer over the two packages' reads. |

## Two ways to be paid, and only one of them uses the invoicing

A payment provider is either the **seller** (Stripe: the operator owns the VAT and issues the invoice) or the **merchant of record** (Paddle: the provider is the seller and issues the invoice). The invoicing and the ANAF service are for the first only; with the second there is nothing for them to do. So Paddle is not a backend of the ANAF service: it is a mode of the billing package, with no invoicing port and no catalog sync. The neutral layer is the event (`ProviderEvent` in `packages/billing/src/provider.ts`), and it does not try to hide who invoices.

## Where each file of billing goes

The billing folder today (`server/src/billing/`) holds two kinds of code, and the seam between them is the plan.

| Generic (the billing package) | Spine's own (stays with the application) |
|---|---|
| `provider.ts` and `providers/` (the `BillingProvider` interface, Stripe, Paddle), `config.ts` (the provider's settings) | `core/src/billing/plans.ts` (`entitlementsOf`: what each plan includes, and the one place a limit is written) |
| `events.ts` (`applyProviderEvent`: who a message is for, whether it is news, the row it leaves, the second subscription, a capped offer's places), which asks a `PlanMapping` what a price is for | `spinePlans` (`server/src/plans/mapping.ts`: what Spine's prices are for), `seat.ts` (the family seats, `standingOf`), `entitlements.ts` (vault bytes and live shares) |
| `withdrawal-share.ts`, `withdrawal-mail.ts`, the withdrawal routes | the meters and what they allow: `gate.ts`, `budget.ts`, `cost.ts`, `fair-use.ts`, `fair-use-admin.ts`, `carry.ts`, `window.ts`, `watch.ts`, `totals.ts`, `links.ts`, `addons.ts`, `invitations.ts` |
| `invoicing/` (the queue, the issuers, `bnr.ts`, the threshold and the alert) | the plan's words on the account page and the pricing page |
| `catalog.ts` (today reads prices the operator names in the environment; becomes the product catalog) | |

The generic part knows "an account has a subscription to a product". The application says what that product includes. The one place the two meet is the function that turns the prices on a subscription into a plan; it is the `PlanMapping` the application passes with each message.

## The product catalog

Today the provider's dashboard is the source of truth: the operator creates prices there and names their ids in the environment, and `loadPrices` in `server/src/billing/catalog.ts` reads each back (amount, currency, interval) with `readPrice`. The catalog has Spine's slots (Essential, Premium, founding, family, the page top-up) and cannot hold another application's product.

The package keeps its own catalog and the provider's objects become a mirror of it.

- **What a product is.** The application declares its products in code, each of a kind the package ships: a subscription (a monthly and a yearly price), a capped offer (a subscription with a number of places, as the founding price is), a one-time pack (the page top-up), a seat add-on. The application also says what the product's entitlement means. A new product of an existing kind needs no new code in the package; a new kind does.
- **What an administrator edits.** Only what is commercial: the name and description, the amount in each currency, which intervals are sold, the trial, whether it is on sale, the cap. What a plan lets an account do (pages, seats, features) is the application's code and is not edited from a page, because a limit that a form can write is a limit that a typing error or a taken-over session can change.
- **A price is a version.** A provider's price cannot be changed, so a new amount is a new version, and an existing subscriber stays on the version they bought. Moving them is a separate, explicit action, and it needs the notice that consumer law asks for before it is offered. Nothing is deleted: a product or a price is archived, so an old subscription and its invoices still say what was sold.
- **Publishing.** A draft shows what it will do (the new version, the sync, the number who stay on the old one). Publishing sends it to the provider by an idempotent sync that finds the object by its lookup key and makes it when it is missing, and records the provider's id. The page then shows each product's state: in step, failed, or different from what the provider holds, found by the read that `readPrice` already makes.
- **Checkout and events do not change.** `createCheckout` takes a price id, and the events carry price ids; the id now comes from the mapping, not from the environment.

## The invoicing port

`InvoiceIssuer` (`packages/billing/src/invoicing/issuer.ts`) takes an `InvoiceDraft` and returns an `IssuedInvoice`, and the queue calls nothing else. It has two implementations behind the same interface: the one that runs the e-Factura code in the process (Spine on its own host, a single application), and one that calls the ANAF service over HTTP. Billing does not know which it has. The call to the service is:

- **Repeat-safe** on the tenant and the payment reference: the queue asks again until an answer, and a payment is numbered once.
- **Asynchronous in what ANAF decides:** the number and the XML come at once, ANAF's decision later, by a status message to the application and by a read.
- **The same for a credit note**, with a link to the invoice it reverses.

## The ANAF service

A **tenant** is a seller company: its ANAF authorisation (sealed), its seller's details, its series and its counter. The applications of one company share one tenant, which is also what keeps two applications from each numbering their invoices from one. The package is organised around the OAuth layer that every ANAF API needs (authorisation, the tokens and their refresh, the sealing, the rate limit, the connection test), with one client for each API on it: e-Factura first, then the public company lookup, then e-Transport and what else ANAF offers through the same authorisation (what is not read from ANAF's own documentation is not promised). The service adds API keys, its own database and the status messages. Whether one ANAF client can act for many companies is not yet answered by ANAF, and the service is not built before it is.

## What stays out of the first version

- VAT computed from the buyer's country and tax number: the caller sends the VAT, as an `InvoiceDraft` line already does.
- A hosted billing service: the package comes first, and a hosted one would be the same code behind HTTP.
- A payment processor beyond Stripe, until a customer needs one.

## Rules each package keeps

- A package imports nothing from Spine's server, web or core, and Spine reaches it by its name, never by path. What a package needs from storage is an interface it defines, and Spine's store satisfies it.
- A package reads no environment variable: the application passes its settings.
- A package's tables carry a prefix of its own, and it creates no table that references another package's.
- Spine's identity code is reached only through its one door, and no file outside it imports one of its files.
- A change to what a package stores that is not a new defaulted column needs numbered, repeatable migrations before an application with data other than Spine's uses it; until then the rule that applies to Spine's own tables applies.

## Order, and what is built

1. This page.
2. Identity gets its one door and the check that holds it.
3. The ANAF link is the workspace package `packages/anaf/` (`spine-anaf`): the e-Factura code with its own error, its own invoice types and the store it asks for written in the package, behind one door that a check holds (S15), and built before the server (`npm run build:anaf`; the Dockerfiles, `scripts/check.sh` and `install.sh` do it). The billing code reaches it through `packages/billing/src/invoicing/efactura.ts`, which gives it what is Spine's (the National Bank's rate, the PDF's path) and turns its error into the queue's. The tenant (a column with one default value) comes with the first step that needs it.
4. Billing is the workspace package `packages/billing/` (`spine-billing`): the provider's adapters, its messages applied to an account, the product catalog and its sync, withdrawals, and the invoices issued for payments. Spine's plan files (the meters, the seats, the limits the routes ask, the top-up and the invitation bonus) are in `server/src/plans/`. The package names no plan and nothing of Spine's (S16): what a price is for is a `PlanMapping` the application passes with each message (`server/src/plans/mapping.ts` is Spine's), the words at the checkout, the return address and which details are complete are a `Presentation`, and the store, the log and the operator's alert are given once with `useBillingHost` (`server/src/billing/host.ts`). `server/src/billing/` is what remains Spine's: the settings read from the environment, the prices' shape for the pricing page, the mail about a withdrawal, and the queue's entry points.
5. The catalog (`packages/billing/src/products.ts`, the tables `catalog_products`, `catalog_prices` and `catalog_links`), its sync to Stripe and its admin page (`/admin/products`) take the place of the prices in the environment. The application declares its products as templates (`server/src/plans/products.ts` is Spine's), an administrator edits the commercial part, and a price that has been sent replaces the environment's id where the pricing page and the checkout read it. The environment's price ids stay as the starting point, taken into the catalog by one button, and as the fallback where the catalog has nothing. `server/src/billing/config.ts` still names Spine's slots (Essential, family, the top-up) for them; that goes when the ids do.
6. The ANAF service and the remote issuer, once ANAF has answered.

Steps built are recorded in [../structure-rules.md](../structure-rules.md), where each rule that a check holds is listed.
