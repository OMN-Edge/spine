/**
 * Long lists for the screenshots (`screens.mjs`): 60 made invoices for one account and 60 accounts with a subscription, so the paging of the account's invoices
 * and the operator's subscriptions (25 to a page) is seen and not only said. Writes to the accounts store as the CLI does (invented addresses, no payment), with the
 * same environment as the server it is run beside.
 *
 *   node browser-check/seed-lists.mjs owner@example.com [count]
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [, , email, count = '60'] = process.argv;
if (!email) throw new Error('usage: node browser-check/seed-lists.mjs <email> [count]');
const { useAccountsStore } = await import(pathToFileURL(path.join(root, 'server/dist/store.js')).href);
const { getAccountsStore } = await import('spine-core/store/index.js');
useAccountsStore();
const store = getAccountsStore();
const owner = await store.users.findByEmail(email);
if (!owner) throw new Error(`no account ${email}`);

const day = n => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
for (let n = 1; n <= Number(count); n++) {
  const ref = `seed_invoice_${n}`;
  await store.billing.queueInvoice(ref, owner.id, day(n));
  await store.billing.updateInvoice(ref, { state: 'done', series: 'TST', number: String(n).padStart(4, '0'), issuer_ref: `seed-${n}`, eu_minor: 0 }, day(n));
}
const plans = ['essential', 'premium', 'family'];
for (let n = 1; n <= Number(count); n++) {
  const id = `seed-user-${n}`;
  await store.users.create({ id, email: `seed${n}@example.com`, passwordHash: 'x', createdAt: day(n), verifiedAt: day(n), consent: undefined });
  await store.billing.put({
    user_id: id, provider: 'stripe', customer_id: `cus_seed_${n}`, subscription_id: `sub_seed_${n}`, interval: n % 3 === 0 ? 'month' : 'year', plan: plans[n % 3], status: n % 7 === 0 ? 'past_due' : 'active',
    founding: false, current_period_end: day(n + 300), cancel_scheduled: n % 11 === 0, updated_at: day(n),
  });
}
console.log(`seeded ${count} invoices for ${email} and ${count} subscriptions`);
