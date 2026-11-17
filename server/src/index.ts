import { objects } from './objects/index.js';
import { sessionRoutes } from './routes/sessions.js';
import { edgeCheck, trustProxySetting } from './trust-proxy.js';
import { serverHeaders, serverHeadersOn } from './headers.js';
import Fastify from 'fastify';
import { sameOriginOnly } from './same-origin.js';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { sessionPersistence } from './session-store.js';
import fastifyStatic from '@fastify/static';
import { cacheControlFor } from './static-cache.js';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { authRoutes } from './routes/auth.js';
import { totpRoutes } from './routes/totp.js';
import { emailSecondFactorRoutes } from './routes/email-second-factor.js';
import { accountRoutes } from './routes/accounts.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { delegationRoutes } from './routes/delegation.js';
import { billingRoutes } from './routes/billing.js';
import { sellerNameWarning } from './billing/invoicing/config.js';
import { operatorInfo } from './legal.js';
import { familyRoutes } from './routes/family.js';
import { reminderRoutes } from './routes/reminders.js';
import { ownAccountRoutes } from './routes/own-account.js';
import { adminRoutes } from './routes/admin.js';
import { passkeyRoutes } from './routes/passkeys.js';
import { enrolmentRoutes } from './routes/enrolment.js';
import { vaultRoutes } from './routes/vault.js';
import { relayRoutes } from './routes/relay.js';
import { demoRelayRoutes } from './routes/demo-relay.js';
import { trustAnchorRoutes } from './routes/trust-anchors.js';
import { securityTxtRoutes } from './routes/security-txt.js';
import { copyOfTheSite, seoRoutes } from './seo.js';
import { healthRoutes } from './routes/health.js';
import { sharedRoutes, shareShellRoutes } from './routes/shared.js';
import { jobsAreExternal, runJobs } from './jobs.js';
import { limitsWhere, SharedRateLimitStore } from './limits.js';
import { decorateAuth } from 'spine-core/routes/middleware.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { ConfigError, resolveBackupDir, resolveDataDir } from 'spine-core/config.js';
import { keepPrivate, privateByDefault } from './permissions.js';
import { keepsFilesHere } from './local-files.js';
import { disk, quotaWarning } from './disk-space.js';
import { loadConfig, loadRegistrationMode, sessionLimits, vaultLimits, type Config } from './config.js';
import { useLogger } from 'spine-core/logger.js';
import { useAccountsStore } from './store.js';
import { useSessionAuth } from './identity/index.js';
import { asHttp } from './http-host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// P3: validate before anything binds an interface or opens the database.
function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// The server keeps accounts, the vault and sealed shares, and no table for a record (SECURITY.md M-37).
useAccountsStore();
useSessionAuth();

const config = loadConfigOrExit();
// What this process makes is for its own user alone, and the directories that hold the data and its backups are closed to everyone else, whatever
// mode earlier files were made with (SECURITY.md S-61).
privateByDefault();
if (keepsFilesHere()) {
  const closed = keepPrivate([resolveDataDir(), resolveBackupDir()]);
  if (closed.length > 0) console.log(`closed to other users: ${closed.join(', ')}`);
} else {
  console.log('keeps no file on this machine: the accounts are in Postgres and the sealed bytes in a bucket');
}
// A bad SPINE_OBJECTS stops the process here and not at the first upload.
try { objects(); } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); }
// With open registration anyone can make accounts: say at start if the disk could not hold a handful of them at the quota (SECURITY.md S-56).
const roomWarning = loadRegistrationMode() === 'open' ? quotaWarning(disk.free(), vaultLimits().accountBytes) : null;
if (roomWarning) console.warn(`warning: ${roomWarning}`);

const app = Fastify({
  logger: true,
  trustProxy: trustProxySetting(), // nginx sits in front, on this host, the proxy named in SPINE_TRUSTED_PROXIES, or the platform's hops (SPINE_TRUSTED_HOPS) (S-31)
});

// From here on, modules that log without the app (the parser, the LLM) write to the
// same structured log as everything else.
useLogger({
  info: (message, detail) => app.log.info(detail ?? {}, message),
  warn: (message, detail) => app.log.warn(detail ?? {}, message),
  error: (message, detail) => app.log.error(detail ?? {}, message),
});

// The server calls no model any more (a device's calls go through the relay, M-35), so it builds no model client and needs no
// credential. The settings a device is given were validated with the rest of the config above; the provider's own (endpoint, region,
// project, no stray Google key: P3, M-8) are the relay's, which checks them and says where its calls go when it starts. P8: residency has
// to be observable, so log what the device is told to use.
{
  const mismatch = sellerNameWarning(config.invoicing, operatorInfo()?.name);
  if (mismatch) app.log.warn(mismatch);
}
app.log.info(
  {
    model: config.llm.model, models: config.llm.models.map(m => m.id), embeddings: config.embeddings.adapter !== 'none',
    // Whether a device may send page images off the device (the parser sends them and the second switch allows it): residency has to be observable.
    parser: config.parser.mode, imageEgress: config.parser.multimodalEnabled && (config.parser.mode === 'multimodal' || config.parser.mode === 'hybrid'),
  },
  'model settings given to devices',
);

// First, before any hook reads an address: where the platform is the proxy, only a request it forwarded is believed about where it came from (S-68).
edgeCheck(app);
// With no proxy of ours in front (Cloud Run), the server sets the headers the proxy would (headers.ts).
if (serverHeadersOn()) serverHeaders(app);
else if (process.env.SPINE_TRUSTED_HOPS) app.log.warn('SPINE_TRUSTED_HOPS is set (the platform is the proxy) and SPINE_SERVER_HEADERS is not on: nothing sets the security headers');
// A copy of the site at another address (a service's own run.app name, a www. name) is not indexed beside it (seo.ts).
copyOfTheSite(app);
// A request that changes something must come from the app's own origin (SECURITY.md S-50).
app.addHook('onRequest', sameOriginOnly);
await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: config.sessionSecret,
  // In the accounts database, so a restart signs no one out (S-16).
  ...sessionPersistence,
  cookie: {
    secure: config.isProduction,
    httpOnly: true,
    maxAge: sessionLimits().absoluteMs, // the row in user_sessions ends it sooner when it is idle (S-33)
    sameSite: 'strict',
  },
});

await app.register(fastifyRateLimit, {
  global: false, // only apply where we explicitly enable it
  // With more than one instance the count is in the database, so it is one count (limits.ts); otherwise the plugin's own, in the process.
  ...(limitsWhere() === 'store' ? { store: SharedRateLimitStore as never } : {}),
});

const webDist = path.join(__dirname, '../../web/dist');

// requireAuth sets req.userId; the property has to exist before routes use it.
decorateAuth(asHttp(app));

// Register API routes
await app.register(authRoutes);
await app.register(totpRoutes);
await app.register(emailSecondFactorRoutes);
await app.register(sessionRoutes);
await app.register(accountRoutes, { registration: config.registration, instance: config.instance });
await app.register(ownAccountRoutes);
await app.register(billingRoutes);
await app.register(familyRoutes);
await app.register(reminderRoutes);
await app.register(waitlistRoutes);
await app.register(adminRoutes);
await app.register(passkeyRoutes);
await app.register(enrolmentRoutes);
await app.register(vaultRoutes);
await app.register(delegationRoutes);
await app.register(relayRoutes);
await app.register(demoRelayRoutes);
await app.register(trustAnchorRoutes);
await app.register(securityTxtRoutes);
await app.register(seoRoutes, { webDist });
await app.register(healthRoutes);
await app.register(sharedRoutes);
// The records are on the device (stage 5): the server registers no route that reads or writes one, and the routes the device's
// core runs (documents, uploads, tags, chat, ...) are not served here. A recipient's address gets the app shell.
await app.register(shareShellRoutes, { appShellPath: path.join(webDist, 'index.html') });

// Serve built web app for all non-API routes
await app.register(fastifyStatic, {
  root: webDist,
  prefix: '/',
  // Must stay true: the SPA fallback below calls reply.sendFile.
  decorateReply: true,
  // Files whose names carry a hash of their content are kept by the browser; the rest are asked about each time (static-cache.ts).
  setHeaders: (reply, filePath) => {
    const kept = cacheControlFor(filePath);
    if (kept) reply.header('cache-control', kept);
  },
});

app.setNotFoundHandler(async (_req, reply) => {
  // SPA fallback — let React Router handle client-side routes.
  // '/share/' (trailing slash) so only public token URLs are excluded: '/share'
  // itself is the authenticated ShareLinks page and must reach the SPA.
  if (!_req.url.startsWith('/api') && !_req.url.startsWith('/share/')) {
    // The shell for a screen behind a sign-in or a path that is not one: not for a search engine (the public pages have files of their own, seo.ts).
    return reply.header('x-robots-tag', 'noindex').sendFile('index.html', webDist);
  }
  return reply.status(404).send({ error: 'not found' });
});

// Open the store on startup so a bad path or a schema problem stops the
// process here rather than on the first request.
let accounts: Awaited<ReturnType<ReturnType<typeof getAccountsStore>['users']['list']>>;
try {
  accounts = await getAccountsStore().users.list();
} catch (err) {
  // e.g. a database from before multi-user: the message says what to do.
  console.error(`Refusing to start — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (accounts.length === 0) {
  app.log.warn('no user accounts exist — create one with: npm run cli -- create-user <email>');
}

// Work done on a clock (jobs.ts): at start and hourly, unless something outside runs it (`SPINE_JOBS=external`, a Cloud Run job).
if (!jobsAreExternal()) {
  const hourly = () => runJobs((message, detail) => app.log.error(detail, message));
  await hourly();
  setInterval(() => void hourly(), 60 * 60 * 1000).unref();
}

await app.listen({ port: config.port, host: config.host });

// A platform that replaces instances without downtime says SIGTERM and waits a few seconds: stop taking new requests, finish those in flight, then end.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'stopping: finishing the requests in flight');
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
