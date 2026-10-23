import { pathToFileURL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { getStore } from './store/index.js';
import { RESET_TTL_MS, deleteAccount, describeAccount, issueUserToken, resetLink } from './accounts.js';
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
 *   npm run cli -- delete-user <email> [--yes]
 *   npm run cli -- list-users
 *   npm run cli -- check-embeddings
 *   npm run cli -- embed-all <email>
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
  delete-user <email> [--yes]
  list-users
  check-embeddings
  embed-all <email>`;

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
  const store = getStore();

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

    case 'list-users': {
      const users = await store.users.list();
      if (users.length === 0) io.out('no accounts');
      for (const user of users) {
        const status = user.email_verified_at ? '' : '\tUNVERIFIED';
        io.out(`${user.email}\tcreated ${user.created_at}${status}`);
      }
      return 0;
    }

    // Sends one short sentence to the embedding service and says what came back: whether the endpoint, project and
    // model are right, how many numbers, how long it took. Nothing of any document is sent.
    case 'check-embeddings': {
      const { getEmbedder } = await import('./embedding/index.js');
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

    // Makes the vectors for one account's documents now, instead of in the background after the next change.
    case 'embed-all': {
      const user = await store.users.findByEmail(normaliseEmail(positional[0] ?? ''));
      if (!user) { io.err('no such account'); return 1; }
      const { similarityEnabled, syncEmbeddings } = await import('./similarity/index.js');
      if (!similarityEnabled()) { io.err('embeddings are off (SPINE_EMBEDDINGS is none)'); return 1; }
      const { embedded } = await syncEmbeddings(user.id);
      io.out(`embedded ${embedded} document${embedded === 1 ? '' : 's'}`);
      return 0;
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
  process.env.SPINE_STORE_SCOPE = 'accounts'; // the operator's commands touch accounts only (SECURITY.md M-37)
  const code = await runCli(process.argv.slice(2), {
    out: line => console.log(line),
    err: line => console.error(line),
    readPassword: readStdinLine,
  });
  process.exit(code);
}
