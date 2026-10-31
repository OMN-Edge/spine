import { sessionRoutes } from './routes/sessions.js';
import { trustedProxies } from './trust-proxy.js';
import Fastify from 'fastify';
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
import { accountRoutes } from './routes/accounts.js';
import { ownAccountRoutes } from './routes/own-account.js';
import { passkeyRoutes } from './routes/passkeys.js';
import { enrolmentRoutes } from './routes/enrolment.js';
import { vaultRoutes } from './routes/vault.js';
import { relayRoutes } from './routes/relay.js';
import { demoRelayRoutes } from './routes/demo-relay.js';
import { trustAnchorRoutes } from './routes/trust-anchors.js';
import { sharedRoutes, shareShellRoutes, sweepShares } from './routes/shared.js';
import { sweepSessions } from './sessions.js';
import { decorateAuth } from 'spine-core/routes/middleware.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { ConfigError } from 'spine-core/config.js';
import { loadConfig, sessionLimits, type Config } from './config.js';
import { useLogger } from 'spine-core/logger.js';
import { useAccountsStore } from './store.js';
import { useSessionAuth } from './session-auth.js';
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

const app = Fastify({
  logger: true,
  trustProxy: trustedProxies(), // nginx sits in front, on this host, or the proxy named in SPINE_TRUSTED_PROXIES (S-31)
});

// From here on, modules that log without the app (the parser, the LLM) write to the
// same structured log as everything else.
useLogger({
  info: (message, detail) => app.log.info(detail ?? {}, message),
  warn: (message, detail) => app.log.warn(detail ?? {}, message),
  error: (message, detail) => app.log.error(detail ?? {}, message),
});

// The server calls no model any more (a device's calls go through the relay, M-35), so it builds no model client and needs no
// credential. The settings were validated with the rest of the config above (P3, M-8: endpoint, region and project stated, no stray Google
// key). P8: residency has to be observable, so log what the device is told to use.
app.log.info(
  {
    provider: config.llm.provider, model: config.llm.model, endpoint: config.llm.endpoint, embeddings: config.embeddings.adapter,
    // Whether a device may send page images off the device (the parser sends them and the second switch allows it): residency has to be observable.
    parser: config.parser.mode, imageEgress: config.parser.multimodalEnabled && (config.parser.mode === 'multimodal' || config.parser.mode === 'hybrid'),
  },
  'model settings given to devices',
);

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
});

const webDist = path.join(__dirname, '../../web/dist');

// requireAuth sets req.userId; the property has to exist before routes use it.
decorateAuth(asHttp(app));

// Register API routes
await app.register(authRoutes);
await app.register(totpRoutes);
await app.register(sessionRoutes);
await app.register(accountRoutes, { registration: config.registration });
await app.register(ownAccountRoutes);
await app.register(passkeyRoutes);
await app.register(enrolmentRoutes);
await app.register(vaultRoutes);
await app.register(relayRoutes);
await app.register(demoRelayRoutes);
await app.register(trustAnchorRoutes);
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
    return reply.sendFile('index.html', webDist);
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

// Sealed shares that have ended are deleted: at start, and hourly.
// A failure leaves an ended share's sealed bytes on disk longer than it should be, so it is said, not swallowed.
const sweep = () => sweepShares().catch(err => app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'removing ended shares failed'));
await sweep();
setInterval(() => void sweep(), 60 * 60 * 1000).unref();
// Ended sign-ins (browser and address) are deleted for every account the same way, so none outlives its 14 days because its owner never came back.
const sweepSignIns = () => sweepSessions().catch(err => app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'removing ended sign-ins failed'));
await sweepSignIns();
setInterval(() => void sweepSignIns(), 60 * 60 * 1000).unref();

await app.listen({ port: config.port, host: config.host });
