import { pathToFileURL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { getAccountsStore } from 'spine-core/store/index.js';
import { RESET_TTL_MS, deleteAccount, describeAccount, issueUserToken, resetLink } from './accounts.js';
import { useAccountsStore } from './store.js';
import { useModelProviders } from './providers.js';
import {
  checkPasswordPolicy,
  generatePassword,
  hashPassword,
  isPlausibleEmail,
  normaliseEmail,
} from './passwords.js';

/**
 * Operator commands. Accounts are created here, not through the web app: there is
 * no open signup yet, and an instance with no mailer has no other way in.
 *
 *   npm run cli -- create-user <email> [--password-stdin]
 *   npm run cli -- set-password <email> [--password-stdin]
 *   npm run cli -- reset-link <email> [--hours N]
 *   npm run cli -- disable-2fa <email>
 *   npm run cli -- approve-user <email>
 *   npm run cli -- delete-user <email> [--yes]
 *   npm run cli -- grant-plan <email> [--days=N]
 *   npm run cli -- revoke-plan <email>
 *   npm run cli -- waitlist
 *   npm run cli -- waitlist-remove <email>
 *   npm run cli -- metrics [--days=N]
 *   npm run cli -- list-users
 *   npm run cli -- check-embeddings
 *
 * Without --password-stdin a password is generated and printed once. It is never
 * stored anywhere readable and cannot be shown again.
 */

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** First line of standard input, for --password-stdin. */
  readPassword(): Promise<string>;
}

const USAGE = `usage:
  create-user <email> [--password-stdin]
  set-password <email> [--password-stdin]
  reset-link <email> [--hours N]
  disable-2fa <email>
  approve-user <email>
  grant-plan <email> [--days=N]
  revoke-plan <email>
  waitlist
  waitlist-remove <email>
  metrics [--days=N]
  delete-user <email> [--yes]
  list-users
  check-embeddings`;

async function choosePassword(flags: string[], io: CliIo): Promise<{ password: string; generated: boolean }> {
  if (flags.includes('--password-stdin')) {
    return { password: (await io.readPassword()).replace(/\r?\n$/, ''), generated: false };
  }
  return { password: generatePassword(), generated: true };
}

/** Returns the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  const flags = rest.filter(arg => arg.startsWith('--'));
  const positional = rest.filter(arg => !arg.startsWith('--'));
  const store = getAccountsStore();

  switch (command) {
    case 'create-user': {
      const email = normaliseEmail(positional[0] ?? '');
      if (!isPlausibleEmail(email)) {
        io.err('create-user needs a valid email address');
        return 2;
      }
      if (await store.users.findByEmail(email)) {
        io.err(`an account for ${email} already exists`);
        return 1;
      }

      const { password, generated } = await choosePassword(flags, io);
      const problem = checkPasswordPolicy(password);
      if (problem) {
        io.err(problem);
        return 1;
      }

      await store.users.create({
        id: uuidv4(),
        email,
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString(),
        // The operator vouches for the address, so there is nothing to confirm.
        verifiedAt: new Date().toISOString(),
      });

      io.out(`created ${email}`);
      io.out('at its first sign-in the account agrees to the privacy notice and the terms (docs/legal/), then chooses its own master password and receives its recovery kit');
      io.out('the password below only gets the person to that screen; it is replaced there and Spine keeps no copy of the new one');
      if (generated) io.out(`password (shown once): ${password}`);
      return 0;
    }

    case 'set-password': {
      const email = normaliseEmail(positional[0] ?? '');
      const user = await store.users.findByEmail(email);
      if (!user) {
        io.err(`no account for ${email}`);
        return 1;
      }

      // An account with a vault signs in with a value its device derives from the master password. A password set here would be a second
      // credential the person's device never sends, and could not open the records: the way back is the reset link and the recovery kit.
      if (await store.vault.getKeys(user.id)) {
        io.err(`${email} has a vault: its password is chosen on the person's device. Send a reset link (reset-link) and have them use their recovery kit`);
        return 1;
      }

      const { password, generated } = await choosePassword(flags, io);
      const problem = checkPasswordPolicy(password);
      if (problem) {
        io.err(problem);
        return 1;
      }

      await store.users.setPassword(user.id, await hashPassword(password));
      io.out(`password changed for ${email}; their other sessions are signed out`);
      if (generated) io.out(`password (shown once): ${password}`);
      return 0;
    }

    case 'reset-link': {
      const email = normaliseEmail(positional[0] ?? '');
      const user = await store.users.findByEmail(email);
      if (!user) {
        io.err(`no account for ${email}`);
        return 1;
      }

      // Works without a mailer, which is the point: this is how an instance that
      // sends no mail recovers an account. Single-use, like the emailed kind.
      const hoursFlag = flags.find(flag => flag.startsWith('--hours='));
      const hours = hoursFlag ? Number(hoursFlag.split('=')[1]) : 1;
      if (!Number.isFinite(hours) || hours <= 0 || hours > 72) {
        io.err('--hours must be between 0 and 72');
        return 2;
      }

      const token = await issueUserToken(user.id, 'reset', hours === 1 ? RESET_TTL_MS : hours * 3_600_000);
      io.out(`one-time link for ${email}, valid ${hours} hour${hours === 1 ? '' : 's'}:`);
      io.out(resetLink(token));
      return 0;
    }

    case 'disable-2fa': {
      const email = normaliseEmail(positional[0] ?? '');
      const user = await store.users.findByEmail(email);
      if (!user) {
        io.err(`no account for ${email}`);
        return 1;
      }
      if (!(await store.users.getTotp(user.id))) {
        io.out(`${email} has no two-factor to turn off`);
        return 0;
      }

      // For a lost phone with no recovery codes. It also ends their sessions, so a
      // session opened by whoever has the phone does not outlive the reset.
      await store.users.disableTotp(user.id);
      io.out(`two-factor turned off for ${email}; their sessions are signed out`);
      return 0;
    }

    case 'delete-user': {
      const email = normaliseEmail(positional[0] ?? '');
      const user = await store.users.findByEmail(email);
      if (!user) {
        io.err(`no account for ${email}`);
        return 1;
      }

      const held = await describeAccount(user.id);
      if (!flags.includes('--yes')) {
        io.err(
          `${email} has ${held.objects} sealed object(s) in its vault. ` +
            'Deleting removes them, the keys that open them and its sealed share links, and cannot be undone. ' +
            'Run again with --yes to do it.',
        );
        return 1;
      }

      await deleteAccount(user.id);
      io.out(`deleted ${email}: ${held.objects} sealed object(s)`);
      io.out('database snapshots already taken still hold the rows until they are pruned');
      return 0;
    }

    // For an account that signed up under SPINE_REGISTRATION=approval. Its address counts as confirmed from here: the operator vouches for it.
    case 'approve-user': {
      const email = normaliseEmail(positional[0] ?? '');
      const user = await store.users.findByEmail(email);
      if (!user) { io.err(`no account for ${email}`); return 1; }
      if (!(await store.users.approve(user.id, new Date().toISOString()))) { io.err(`${email} is not waiting for approval`); return 1; }
      io.out(`approved ${email}; they can sign in now`);
      return 0;
    }

    // The paid plan without a payment: for a friend, a tester, a press account. It ends on its own, and shows as the operator's in the app.
    case 'grant-plan': {
      const email = normaliseEmail(positional[0] ?? '');
      const user = await store.users.findByEmail(email);
      if (!user) { io.err(`no account for ${email}`); return 1; }
      const daysFlag = flags.find(flag => flag.startsWith('--days='));
      const days = daysFlag ? Number(daysFlag.split('=')[1]) : 365;
      if (!Number.isInteger(days) || days < 1 || days > 3650) { io.err('--days must be a whole number from 1 to 3650'); return 2; }
      const existing = await store.billing.get(user.id);
      if (existing?.provider === 'paddle' && existing.status !== 'canceled') { io.err(`${email} pays for a plan; change it in the payment provider's dashboard`); return 1; }
      const now = new Date();
      await store.billing.put({
        user_id: user.id, provider: 'operator', customer_id: null, subscription_id: null, interval: null, status: 'active', founding: false,
        current_period_end: new Date(now.getTime() + days * 86_400_000).toISOString(), cancel_scheduled: true, updated_at: now.toISOString(),
      });
      io.out(`${email} has the paid plan for ${days} day${days === 1 ? '' : 's'} (shown to them as granted); it takes effect only where SPINE_BILLING=on`);
      return 0;
    }

    case 'revoke-plan': {
      const email = normaliseEmail(positional[0] ?? '');
      const user = await store.users.findByEmail(email);
      if (!user) { io.err(`no account for ${email}`); return 1; }
      const existing = await store.billing.get(user.id);
      if (existing?.provider !== 'operator' || existing.status === 'canceled') { io.err(`${email} has no granted plan`); return 1; }
      const now = new Date().toISOString();
      await store.billing.put({ ...existing, status: 'canceled', current_period_end: now, updated_at: now });
      io.out(`the granted plan of ${email} has ended`);
      return 0;
    }

    // The people who asked to be told when Spine opens, one address a line with the day and where they asked, to paste into a mailing tool.
    case 'waitlist': {
      const list = await store.waitlist.list();
      for (const entry of list) io.out(`${entry.email}\t${entry.created_at.slice(0, 10)}\t${entry.source ?? ''}`);
      io.err(`${list.length} address${list.length === 1 ? '' : 'es'}`);
      return 0;
    }

    case 'waitlist-remove': {
      const email = normaliseEmail(positional[0] ?? '');
      if (!(await store.waitlist.remove(email))) { io.err(`${email} is not on the list`); return 1; }
      io.out(`removed ${email}`);
      return 0;
    }

    // How the loops in the marketing plan are doing: counts by name over the last N days (default 30). Never who.
    case 'metrics': {
      const daysFlag = flags.find(flag => flag.startsWith('--days='));
      const days = daysFlag ? Number(daysFlag.split('=')[1]) : 30;
      if (!Number.isInteger(days) || days < 1 || days > 3650) { io.err('--days must be a whole number from 1 to 3650'); return 2; }
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const totals = await store.metrics.totals(since);
      for (const t of totals) io.out(`${t.name}\t${t.total}`);
      if (totals.length === 0) io.out(`nothing counted since ${since}`);
      return 0;
    }

    case 'list-users': {
      const users = await store.users.list();
      if (users.length === 0) io.out('no accounts');
      for (const user of users) {
        const status = (user.approved === 0 ? '\tWAITING FOR APPROVAL' : '') + (user.email_verified_at ? '' : '\tUNVERIFIED');
        io.out(`${user.email}\tcreated ${user.created_at}${status}`);
      }
      return 0;
    }

    // Sends one short sentence to the embedding service and says what came back: whether the endpoint, project and
    // model are right, how many numbers, how long it took. Nothing of any document is sent.
    case 'check-embeddings': {
      const { getEmbedder } = await import('spine-core/embedding/index.js');
      const embedder = getEmbedder();
      if (!embedder.enabled) { io.err('embeddings are off (SPINE_EMBEDDINGS is none)'); return 1; }
      const started = Date.now();
      try {
        const [v] = await embedder.embed(['a short test sentence'], 'query');
        io.out(`ok: ${embedder.id}, ${v.length} numbers in ${Date.now() - started} ms`);
        return 0;
      } catch (err) {
        io.err(`failed: ${err instanceof Error ? err.message : String(err)}`);
        // Most often the model is not one this endpoint serves: ask it which are.
        if (embedder.availableModels) {
          try {
            const served = await embedder.availableModels();
            io.err(served.length > 0
              ? `this endpoint serves these embedding models: ${served.join(', ')}. Set SPINE_EMBEDDING_MODEL to one of them.`
              : 'this endpoint lists no embedding models for this project.');
          } catch (listing) {
            io.err(`could not list the endpoint's models either: ${listing instanceof Error ? listing.message : String(listing)}`);
          }
        }
        return 1;
      }
    }

    default:
      io.err(USAGE);
      return 2;
  }
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    if (chunk.includes(10)) break;
  }
  return Buffer.concat(chunks).toString('utf8').split('\n')[0] ?? '';
}

// Only when executed directly, so importing this in a test does not run it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  useAccountsStore(); // the operator's commands touch accounts only (SECURITY.md M-37)
  useModelProviders();
  const code = await runCli(process.argv.slice(2), {
    out: line => console.log(line),
    err: line => console.error(line),
    readPassword: readStdinLine,
  });
  process.exit(code);
}
