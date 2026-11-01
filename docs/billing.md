# Plans and payment

How an instance sells Spine, and how an operator sets it up. **Off by default**: with `SPINE_BILLING` unset nothing here applies, and an account is limited only by the instance's own ceilings (`SPINE_VAULT_MAX_MB`, `SPINE_SHARE_MAX_LIVE`, `SPINE_RELAY_DAILY_CALLS`). A self-hosted or private instance (`SPINE_INSTANCE=private`, which refuses `SPINE_BILLING=on`) leaves it off. The reasons for each design choice are in SECURITY.md **M-45**.

## The plans

| Plan | Price | What it is |
| --- | --- | --- |
| Free trial | €0 for six months from sign-up | Everything, with 150 pages of AI reading in all, records for up to six people, and letting other accounts into them |
| Free | €0 | One person's records, storage up to 1 GB, the timeline, search, export, the emergency card, one live share link without translation, about 30 pages of AI reading a month |
| Premium | €39 a year or €3.99 a month | One person's records, reading within fair use (4000 pages a month), translation, questions, connections and related documents, any number of share links, approval mode |
| Founding member | €29 a year | The yearly Premium for the first 500 paying accounts, kept for as long as the subscription runs |
| Family | €79 a year or €7.99 a month | Premium for up to six people, with child profiles, other accounts let in, teenagers' own accounts and promotion at eighteen; reading within fair use of 12,000 pages a month for them all. Sold only where both its prices are named |

`core/src/billing/plans.ts` is the one place these are written: the relay, the routes and the account page all ask it, and the pricing page shows what the server tells it. The amounts must match the prices created at the payment provider. Nothing is ever deleted when a plan ends: the records stay and export; what changes is what an account may add and use. The family plan is sold only when `SPINE_PADDLE_PRICE_FAMILY_YEAR` and `SPINE_PADDLE_PRICE_FAMILY_MONTH` are set. Changing from Premium to the family plan, or back, is done in Paddle's customer portal (a subscription to a price of the other plan is the other plan: the webhook reads it from the prices), not by a second checkout.

An account's plan is worked out, never stored: a running subscription gives Premium; otherwise the trial counts from the day the account was made; otherwise Free (`entitlementsOf`). A cancelled subscription keeps Premium to the end of what was paid for, and a late payment keeps it a few days (`PAST_DUE_GRACE_DAYS`) while the provider tries again.

## What is measured

AI processing is measured at the relay, which sees every request, in thousandths of a page (`taskCost`): a fixed part for the task and a part for each kilobyte of the request. A call is checked before it runs (the plan includes the task, and allowance is left) and charged after it succeeds, so a failed call costs nothing. Several calls in flight at once can overshoot an allowance by a few; the relay's daily count bounds that. **The weights are first guesses** from the marketing plan's figures (about 2,500 tokens in and 1,500 out for a page of reading); replace them with figures from the provider's usage logs. A share's recipient is held to the owner's plan for features (translation, questions) and counted against the share's own daily calls, not the owner's allowance.

The vault's size and the number of live shares are limited by plan in the routes that already enforced the instance's ceilings (`billing/entitlements.ts`). Approval mode is refused to Free on creating a link and on changing one.

## Setting it up with Paddle

Paddle is the merchant of record: it charges, issues invoices and accounts for VAT, and Spine never sees a card.

1. In Paddle, create three prices on one product: yearly (€39), monthly (€3.99) and the founding yearly price (€29), and, to sell the family plan, two more: yearly (€79) and monthly (€7.99). Set each price's quantity to a minimum and maximum of 1: Paddle allows up to 100 by default and its checkout then offers a quantity picker, so a person could pay for several and still get one plan. Create a notification destination for `https://<your domain>/api/billing/webhook` with the events `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.canceled`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.trialing` and `transaction.completed`, and copy its secret. Create an API key and a client-side token.
2. Serve `checkout/` from **its own origin** (for example `pay.<your domain>`), copy `checkout/config.example.js` there under the name config.js and fill it in, and make that address Paddle's default payment link (Checkout, Checkout settings, Default payment link). A checkout opens there: Spine does not name the page in its request, because Paddle refuses an address whose domain it has not approved, in the sandbox too, and a default that is another page is logged. It must not be the app's origin: Paddle's script then never runs where a person's records are open. Its content security policy needs Paddle's script, frames and connections (see Paddle's guidance) and nothing of the app's.
3. Set the variables below on the server and restart. `PADDLE_ENVIRONMENT` has no default because one value charges real money: try everything in `sandbox` first.

| Variable | Purpose |
| --- | --- |
| `SPINE_BILLING` | `on` to have plans. Off by default; refused with `SPINE_INSTANCE=private` |
| `PADDLE_ENVIRONMENT` | `sandbox` or `production` |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET` | The API key (creates a checkout, opens the customer portal) and the notification destination's secret (checks a message is Paddle's) |
| `SPINE_PADDLE_PRICE_YEAR`, `SPINE_PADDLE_PRICE_MONTH`, `SPINE_PADDLE_PRICE_FOUNDING` | The ids of the three prices |
| `SPINE_PADDLE_PRICE_FAMILY_YEAR`, `SPINE_PADDLE_PRICE_FAMILY_MONTH` | The family plan's two prices; both or neither |
| `SPINE_CHECKOUT_URL` | The address of the checkout page above, the same as Paddle's default payment link (a checkout that opens elsewhere is logged) |
| `SPINE_WAITLIST` | `on` shows "Tell me when Spine opens" on the front page while accounts cannot be made |

The relay applies the plans and needs only `SPINE_BILLING=on` and the store (it never calls the payment provider, so it does not need its settings), and it shares the server's database, so with several instances use Postgres (`SPINE_STORE=postgres`).

## The routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/pricing` | anyone | The prices, whether the family plan is sold, and the founding places left; `{ enabled: false }` where there are no plans |
| `GET /api/billing` | signed in | The account's plan, what it has used (AI reading, storage, share links), what it includes, and whether it can manage billing |
| `POST /api/billing/checkout` | signed in | Starts a purchase for `{ interval, plan }` at the provider and answers where to send the person; refused for an account that already has a plan |
| `POST /api/billing/portal` | signed in, with a Paddle subscription | Opens the provider's page for the card, invoices, switching and cancelling |
| `POST /api/billing/webhook` | the provider only | Its signed messages; anything not signed correctly is refused |
| `POST /api/waitlist` | anyone | An address to be told when Spine opens; the same answer whether or not it was there; five a minute per source |

## Checking it

`npm test -w spine-server` covers the signature check, the order of messages, the founding places, the gate and the limits. With Paddle's sandbox: buy with a test card from the account page, watch `subscription.created` arrive, confirm the account page says Premium, cancel from the portal, and confirm it says the subscription ends and Premium stays to the end of the period. A webhook that cannot be placed (a subscription message ahead of its purchase) is answered 409 and Paddle sends it again.

## Operating it

- `npm run cli -- grant-plan you@example.com --days=90 [--plan=family]` gives the paid plan without a payment (a friend, a reviewer); `revoke-plan` ends it.
- `npm run cli -- waitlist` lists the addresses that asked to be told when Spine opens, `waitlist-remove` removes one.
- `npm run cli -- metrics --days=30` shows the counts the marketing plan measures: `signup`, `signup_from_share`, `signup_from_doctors`, `signup_from_card`, `signup_from_invite`, `share_opened`, `card_opened`, `checkout_started`, `paid_event`. They are numbers a day under a name, never who.
- An account with a running subscription cannot be deleted until the subscription is cancelled, so a person who leaves is not charged afterwards.
