import { sessionRoutes } from './routes/sessions.js';
import { trustedProxies } from './trust-proxy.js';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { authRoutes } from './routes/auth.js';
import { totpRoutes } from './routes/totp.js';
import { accountRoutes } from './routes/accounts.js';
import { ownAccountRoutes } from './routes/own-account.js';
import { passkeyRoutes } from './routes/passkeys.js';
import { vaultRoutes } from './routes/vault.js';
import { relayRoutes } from './routes/relay.js';
import { trustAnchorRoutes } from './routes/trust-anchors.js';
import { sharedRoutes, shareShellRoutes, sweepShares } from './routes/shared.js';
import { decorateAuth } from './routes/middleware.js';
import { getStore } from './store/index.js';
import { loadConfig, ConfigError, sessionLimits, type Config } from './config.js';
import { useLogger } from './logger.js';

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

// The server keeps accounts, the vault and sealed shares, and no table for a record (SECURITY.md M-37). Set before the store is first read.
process.env.SPINE_STORE_SCOPE = 'accounts';

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
  { provider: config.llm.provider, model: config.llm.model, endpoint: config.llm.endpoint, embeddings: config.embeddings.adapter },
  'model settings given to devices',
);

await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: config.sessionSecret,
  cookie: {
    secure: config.isProduction,
    httpOnly: true,
    maxAge: sessionLimits().absoluteMs, // the row in user_sessions ends it sooner when it is idle (S-33)
    sameSite: 'strict',
  },
});

await app.register(fastifyMultipart, {
  // A zip of files may be large; a single document or photo is held to 200 MB in the upload route.
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

await app.register(fastifyRateLimit, {
  global: false, // only apply where we explicitly enable it
});

const webDist = path.join(__dirname, '../../web/dist');

// requireAuth sets req.userId; the property has to exist before routes use it.
decorateAuth(app);

// Register API routes
await app.register(authRoutes);
await app.register(totpRoutes);
await app.register(sessionRoutes);
await app.register(accountRoutes, { registration: config.registration });
await app.register(ownAccountRoutes);
await app.register(passkeyRoutes);
await app.register(vaultRoutes);
await app.register(relayRoutes);
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
let accounts: Awaited<ReturnType<ReturnType<typeof getStore>['users']['list']>>;
try {
  accounts = await getStore().users.list();
} catch (err) {
  // e.g. a database from before multi-user: the message says what to do.
  console.error(`Refusing to start — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (accounts.length === 0) {
  app.log.warn('no user accounts exist — create one with: npm run cli -- create-user <email>');
}

// Sealed shares that have ended are deleted: at start, and hourly.
await sweepShares().catch(() => undefined);
setInterval(() => void sweepShares().catch(() => undefined), 60 * 60 * 1000).unref();

await app.listen({ port: config.port, host: config.host });
