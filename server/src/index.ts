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
import { documentRoutes } from './routes/documents.js';
import { sourceFileRoutes } from './routes/source-files.js';
import { exportRoutes } from './routes/export.js';
import { getEmbedder, EmbedderConfigError } from './embedding/index.js';
import { similarityRoutes } from './routes/similarity.js';
import { linkRoutes } from './routes/links.js';
import { episodeRoutes } from './routes/episodes.js';
import { demoRoutes } from './routes/demo.js';
import { ownAccountRoutes } from './routes/own-account.js';
import { passkeyRoutes } from './routes/passkeys.js';
import { vaultRoutes } from './routes/vault.js';
import { chatRoutes } from './routes/chat.js';
import { shareRoutes } from './routes/share.js';
import { publicShareRoutes } from './routes/public-share.js';
import { tagRoutes } from './routes/tags.js';
import { trendRoutes } from './routes/trends.js';
import { doctorRoutes } from './routes/doctors.js';
import { decorateAuth } from './routes/middleware.js';
import { reconcileStalledJobs } from './ingestion/pipeline.js';
import { hashLegacyShareTokens } from './hash-legacy-tokens.js';
import { getStore } from './store/index.js';
import { getChatLlm, LlmConfigError } from './llm/index.js';
import { checkParserRequirements, getParser, ParserConfigError } from './parser/index.js';
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

// P3: an unknown provider or an unusable credential must stop the process here,
// not surface later as a failed ingestion. P8: log what it resolved to —
// provider, model and endpoint — because if residency has to be provable it has
// to be observable.
try {
  // Touch it once so a bad provider, endpoint or credential stops the process
  // here instead of at the first upload. getChatLlm() memoizes, so this is the
  // construction and every later call is a read.
  getChatLlm();
  // The one place this is logged. P8: residency has to be observable, so
  // `journalctl -u spine-web | grep "llm provider"` answers "what is this instance
  // actually pointed at". Straight from config — there is no second source.
  app.log.info(
    { provider: config.llm.provider, model: config.llm.model, endpoint: config.llm.endpoint },
    'llm provider ready',
  );

  // M-7: whether page images can leave this host is a startup fact, stated plainly
  // rather than left to be inferred from two settings.
  await checkParserRequirements();
  const parser = getParser();
  app.log.info({ parser: config.parser.mode, imageEgress: parser.imageEgress }, 'parser ready');
  if (parser.imageEgress) {
    app.log.warn(
      { provider: config.llm.provider, endpoint: config.llm.endpoint },
      'page images WILL be sent to the model provider for scanned and handwritten pages',
    );
  }
  // The same for embeddings: constructed once so a missing endpoint or a stray Google API key stops the process here.
  const embedder = getEmbedder();
  if (embedder.enabled) {
    app.log.warn(
      { model: embedder.id, endpoint: config.embeddings.endpoint, region: config.embeddings.region },
      'document summaries WILL be sent to the embedding service to find related documents',
    );
  } else {
    app.log.info('embeddings are off: documents are found by their words only');
  }
} catch (err) {
  if (err instanceof LlmConfigError || err instanceof ParserConfigError || err instanceof EmbedderConfigError) {
    console.error(`Refusing to start — ${err.message}`);
    process.exit(1);
  }
  throw err;
}

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
await app.register(documentRoutes);
await app.register(sourceFileRoutes);
await app.register(exportRoutes);
await app.register(similarityRoutes);
await app.register(linkRoutes);
await app.register(episodeRoutes);
await app.register(demoRoutes);
await app.register(ownAccountRoutes);
await app.register(passkeyRoutes);
await app.register(vaultRoutes);
await app.register(chatRoutes);
await app.register(shareRoutes);
// The share entry route serves the SPA shell, so it needs the build's path.
await app.register(publicShareRoutes, {
  appShellPath: path.join(webDist, 'index.html'),
});
await app.register(tagRoutes);
await app.register(trendRoutes);
await app.register(doctorRoutes);

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

// P6: rewrite any plaintext share token left by a pre-S-4 build. Idempotent,
// so this is a no-op on every boot after the first.
const rewritten = await hashLegacyShareTokens();
if (rewritten.hashed > 0) app.log.warn(`hashed ${rewritten.hashed} plaintext share token(s)`);
for (const id of rewritten.unrecognised) {
  app.log.error({ shareLinkId: id }, 'share_links.token is neither a raw token nor a digest — left as is');
}

// The job registry is in-memory, so anything still marked in-flight was
// stranded by a previous process and will never progress.
const stranded = await reconcileStalledJobs();
if (stranded > 0) app.log.warn(`marked ${stranded} interrupted source_file(s) as errored`);

await app.listen({ port: config.port, host: config.host });
