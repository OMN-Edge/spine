import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AuthRouteOptions } from '../../routes/auth.js';
import type { AccountRouteOptions } from '../../routes/accounts.js';
import type { TotpRouteOptions } from '../../routes/totp.js';
import { OWNER_EMAIL, TEST_PASSWORD, createTestUser } from './seed.js';

/**
 * Stand-in for web/dist/index.html so the share entry route can be driven
 * without a built frontend. The marker is what tests assert on.
 */
export const APP_SHELL_MARKER = '<div id="root"></div>';

function writeAppShell(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-shell-'));
  const file = path.join(dir, 'index.html');
  writeFileSync(file, `<!doctype html><html><body>${APP_SHELL_MARKER}</body></html>`);
  return file;
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

/** Every route a test app registered, for tests that assert on the whole surface. */
export const routesOf = new WeakMap<object, RegisteredRoute[]>();

export interface TestAppOptions {
  /** Pass null to simulate a missing web build. */
  appShellPath?: string | null;
  /**
   * Overrides for the login limiters. The plugin is always registered, so every
   * test drives the real preHandler (P10); the default max is high enough that
   * a test file's own logins do not trip it, and the rate-limit tests pass a
   * small one to prove the 429.
   */
  auth?: AuthRouteOptions;
  /** Signup, verification and recovery. Closed registration unless a test opens it. */
  accounts?: AccountRouteOptions;
  /** Managing the second factor. */
  totp?: TotpRouteOptions;
}

export async function buildTestApp(options: TestAppOptions = {}) {
  process.env.SPINE_DB_PATH = ':memory:';
  process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-chars-long!!';

  // Reset the store singleton so each test file gets a fresh in-memory DB
  const { resetStore } = await import('../../store/index.js');
  resetStore();

  // trustProxy matches production (index.ts): req.ip must come from
  // X-Forwarded-For so the per-source rate limiter keys on the real client.
  const app = Fastify({ logger: false, trustProxy: true });

  const routes: RegisteredRoute[] = [];
  app.addHook('onRoute', route => {
    for (const method of ([] as string[]).concat(route.method)) {
      if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, url: route.url });
    }
  });
  routesOf.set(app, routes);
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: process.env.SESSION_SECRET,
    cookie: { secure: false },
  });
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  // Matches production: registered globally off, applied per route.
  await app.register(fastifyRateLimit, { global: false });

  // Import routes after env vars are set
  const { authRoutes } = await import('../../routes/auth.js');
  const { accountRoutes } = await import('../../routes/accounts.js');
  const { totpRoutes } = await import('../../routes/totp.js');
  const { documentRoutes } = await import('../../routes/documents.js');
  const { sourceFileRoutes } = await import('../../routes/source-files.js');
  const { exportRoutes } = await import('../../routes/export.js');
  const { similarityRoutes } = await import('../../routes/similarity.js');
  const { linkRoutes } = await import('../../routes/links.js');
  const { chatRoutes } = await import('../../routes/chat.js');
  const { shareRoutes } = await import('../../routes/share.js');
  const { publicShareRoutes } = await import('../../routes/public-share.js');
  const { tagRoutes } = await import('../../routes/tags.js');
  const { trendRoutes } = await import('../../routes/trends.js');
  const { doctorRoutes } = await import('../../routes/doctors.js');
  const { decorateAuth } = await import('../../routes/middleware.js');

  decorateAuth(app);

  await app.register(authRoutes, {
    loginRateLimit: { max: 1000, timeWindow: '1 minute' },
    globalLoginRateLimit: { max: 1000, windowMs: 60 * 1000 },
    ...options.auth,
  });
  await app.register(totpRoutes, options.totp ?? {});
  await app.register(accountRoutes, {
    registration: 'operator',
    // Generous by default so a test's own requests do not trip them; the tests
    // that are about limits pass small ones.
    perSource: { max: 1000, timeWindow: '1 minute' },
    perAddress: { max: 1000, windowMs: 60 * 1000 },
    ...options.accounts,
  });
  await app.register(documentRoutes);
  await app.register(sourceFileRoutes);
  await app.register(exportRoutes);
  await app.register(similarityRoutes);
  await app.register(linkRoutes);
  await app.register(chatRoutes, { askPerMinute: 1000 });
  await app.register(shareRoutes);
  await app.register(publicShareRoutes, {
    requestPerSource: { max: 1000, timeWindow: '1 minute' },
    requestPerLink: { max: 1000, windowMs: 60 * 1000 },
    chatPerSource: { max: 1000, timeWindow: '1 minute' },
    chatPerLink: { max: 1000, windowMs: 60 * 1000 },
    appShellPath:
      options.appShellPath === null
        ? path.join(tmpdir(), 'spine-no-such-build', 'index.html')
        : (options.appShellPath ?? writeAppShell()),
  });
  await app.register(tagRoutes);
  await app.register(trendRoutes);
  await app.register(doctorRoutes);

  await app.ready();

  // Every test file starts with one account, so the common case needs no setup.
  await createTestUser();

  return app;
}

/** Log in and return the cookie header to send on later requests. */
export async function loginAs(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  email = OWNER_EMAIL,
  password = TEST_PASSWORD,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  return res.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/** The default owner. */
export function loginSession(app: Awaited<ReturnType<typeof buildTestApp>>) {
  return loginAs(app);
}
