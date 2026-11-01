import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import type { AuthRouteOptions } from '../../routes/auth.js';
import type { AccountRouteOptions } from '../../routes/accounts.js';
import type { TotpRouteOptions } from '../../routes/totp.js';
import type { PasskeyRouteOptions } from '../../routes/passkeys.js';
import type { VaultRouteOptions } from '../../routes/vault.js';
import { holdsRecordsInThisRun } from 'spine-core/testing/store-kind.js';
import { useSessionAuth } from '../../session-auth.js';
import { sessionPersistence } from '../../session-store.js';
import { asHttp, asPlugin } from '../../http-host.js';
import { useShareHost, type ShareHost } from 'spine-core/share-host.js';
import { TRUSTED_PROXIES } from '../../trust-proxy.js';
import { OWNER_EMAIL, TEST_PASSWORD, createTestUser } from './seed.js';

/**
 * The share host a device would bring, as far as the routes can tell: it takes the copy and says nothing went wrong. What a real one
 * makes and sends is tested where it lives (web/src/core/share); the routes' own behaviour is what these tests are about.
 */
export const testShareHost: ShareHost = {
  publish: async () => ({ key: 'test-share-key', published: true, digest: 'test-digest' }),
  update: async () => undefined,
  revoke: async () => undefined,
  pull: async () => undefined,
  answer: async () => undefined,
  publishCard: async ({ id, key }) => ({ id: id ?? 'card-test-id-0000000000000', key: key ?? 'card-test-key' }),
  reviewCard: async () => undefined,
  takeCard: async () => undefined,
  revokeCard: async () => undefined,
  mailsOwner: () => false,
  addressOf: (id, key) => `https://spine.test/share/${id}${key ? `#${key}` : ''}`,
};

export interface RegisteredRoute {
  method: string;
  url: string;
}

/** Every route a test app registered, for tests that assert on the whole surface. */
export const routesOf = new WeakMap<object, RegisteredRoute[]>();

export interface TestAppOptions {
  /** A second server over the same database, as after a restart: the store is not made again. */
  keepStore?: boolean;
  /**
   * Overrides for the login limiters. The plugin is always registered, so every
   * test drives the real preHandler (P10); the default max is high enough that
   * a test file's own logins do not trip it, and the rate-limit tests pass a
   * small one to prove the 429.
   */
  auth?: AuthRouteOptions;
  /** Signup, verification and recovery. Closed registration unless a test opens it. */
  accounts?: AccountRouteOptions;
  admin?: import('../../routes/admin.js').AdminRouteOptions;
  /** Managing the second factor. */
  totp?: TotpRouteOptions;
  /** Passkey sign-in limits. */
  passkeys?: PasskeyRouteOptions;
  enrolment?: import('../../routes/enrolment.js').EnrolmentRouteOptions;
  vault?: VaultRouteOptions;
  shared?: import('../../routes/shared.js').SharedRouteOptions;
  demoRelay?: import('../../routes/demo-relay.js').DemoRelayRouteOptions;
  waitlist?: import('../../routes/waitlist.js').WaitlistRouteOptions;
}

export async function buildTestApp(options: TestAppOptions = {}) {
  process.env.SPINE_DB_PATH = ':memory:';
  process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-chars-long!!';

  // Reset the store singleton so each test file gets a fresh in-memory DB
  const { resetStore, hasStoreFactory, useStoreFactory, createStore } = await import('spine-core/store/index.js');
  // A run that was not set up with one of the store setup files (the web's test of the device against the server) gets the one that holds records.
  if (!hasStoreFactory()) {
    const { loadStoreConfig } = await import('spine-core/config.js');
    const { useDriver } = await import('spine-core/store/sqlite/index.js');
    const { openNative } = await import('spine-core/testing/driver-native.js');
    const { useNodePlatform } = await import('spine-core/testing/node-platform.js');
    useNodePlatform();
    useDriver(openNative);
    useStoreFactory(() => createStore(loadStoreConfig()));
  }
  if (!options.keepStore) resetStore();
  // What the server's entry point registers, and the share host a device would bring.
  useSessionAuth();
  useShareHost(testShareHost);

  // trustProxy matches production (index.ts): req.ip must come from
  // X-Forwarded-For so the per-source rate limiter keys on the real client.
  const app = Fastify({ logger: false, trustProxy: TRUSTED_PROXIES });

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
    ...sessionPersistence,
    cookie: { secure: false },
  });
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  // Matches production: registered globally off, applied per route.
  await app.register(fastifyRateLimit, { global: false });

  // `npm run test:accounts` registers what the server does (index.ts) and no route of a record, on a database without their tables.
  const records = holdsRecordsInThisRun();

  // Import routes after env vars are set
  const { authRoutes } = await import('../../routes/auth.js');
  const { accountRoutes } = await import('../../routes/accounts.js');
  const { totpRoutes } = await import('../../routes/totp.js');
  const { sessionRoutes } = await import('../../routes/sessions.js');
  const { documentRoutes } = await import('spine-core/routes/documents.js');
  const { sourceFileRoutes } = await import('spine-core/routes/source-files.js');
  const { exportRoutes } = await import('spine-core/routes/export.js');
  const { similarityRoutes } = await import('spine-core/routes/similarity.js');
  const { linkRoutes } = await import('spine-core/routes/links.js');
  const { episodeRoutes } = await import('spine-core/routes/episodes.js');
  const { demoRoutes } = await import('spine-core/routes/demo.js');
  const { ownAccountRoutes } = await import('../../routes/own-account.js');
  const { adminRoutes } = await import('../../routes/admin.js');
  const { passkeyRoutes } = await import('../../routes/passkeys.js');
  const { enrolmentRoutes } = await import('../../routes/enrolment.js');
  const { vaultRoutes } = await import('../../routes/vault.js');
  const { delegationRoutes } = await import('../../routes/delegation.js');
  const { relayRoutes } = await import('../../routes/relay.js');
  const { billingRoutes } = await import('../../routes/billing.js');
  const { waitlistRoutes } = await import('../../routes/waitlist.js');
  const { sharedRoutes } = await import('../../routes/shared.js');
  const { demoRelayRoutes } = await import('../../routes/demo-relay.js');
  const { chatRoutes } = await import('spine-core/routes/chat.js');
  const { guideRoutes } = await import('spine-core/routes/guide.js');
  const { emergencyRoutes } = await import('spine-core/routes/emergency.js');
  const { shareRoutes } = await import('spine-core/routes/share.js');
  const { publicShareRoutes } = await import('spine-core/routes/public-share.js');
  const { tagRoutes } = await import('spine-core/routes/tags.js');
  const { trendRoutes } = await import('spine-core/routes/trends.js');
  const { doctorRoutes } = await import('spine-core/routes/doctors.js');
  const { decorateAuth } = await import('spine-core/routes/middleware.js');

  decorateAuth(asHttp(app));

  await app.register(authRoutes, {
    loginRateLimit: { max: 1000, timeWindow: '1 minute' },
    globalLoginRateLimit: { max: 1000, windowMs: 60 * 1000 },
    ...options.auth,
  });
  await app.register(totpRoutes, options.totp ?? {});
  await app.register(sessionRoutes);
  await app.register(accountRoutes, {
    registration: 'operator',
    // Generous by default so a test's own requests do not trip them; the tests
    // that are about limits pass small ones.
    perSource: { max: 1000, timeWindow: '1 minute' },
    perAddress: { max: 1000, windowMs: 60 * 1000 },
    ...options.accounts,
  });
  if (records) await app.register(asPlugin(documentRoutes));
  if (records) await app.register(asPlugin(sourceFileRoutes));
  if (records) await app.register(asPlugin(exportRoutes));
  if (records) await app.register(asPlugin(similarityRoutes));
  if (records) await app.register(asPlugin(linkRoutes));
  if (records) await app.register(asPlugin(episodeRoutes));
  if (records) await app.register(asPlugin(demoRoutes));
  await app.register(ownAccountRoutes);
  await app.register(adminRoutes, options.admin ?? {});
  await app.register(passkeyRoutes, { perSource: 100_000, instanceWide: 100_000, ...options.passkeys });
  await app.register(enrolmentRoutes, { requestsPerSource: 100_000, claimsPerSource: 100_000, instanceWide: 100_000, ...options.enrolment });
  await app.register(vaultRoutes, options.vault ?? {});
  await app.register(delegationRoutes, { claimsPerSource: 1000, promotionsPerSource: 1000, instanceWide: 100000 });
  await app.register(relayRoutes);
  await app.register(billingRoutes);
  await app.register(waitlistRoutes, { perSource: { max: 1000, timeWindow: '1 minute' }, ...options.waitlist });
  await app.register(demoRelayRoutes, options.demoRelay ?? {});
  await app.register(sharedRoutes, { requestPerSource: { max: 1000, timeWindow: '1 minute' }, requestPerLink: { max: 1000, windowMs: 60 * 1000 }, readPerSource: { max: 100000, timeWindow: '1 minute' }, ...options.shared });
  if (records) await app.register(asPlugin(chatRoutes));
  if (records) await app.register(asPlugin(guideRoutes));
  if (records) await app.register(asPlugin(emergencyRoutes));
  if (records) await app.register(asPlugin(shareRoutes));
  if (records) await app.register(asPlugin(publicShareRoutes));
  if (records) await app.register(asPlugin(tagRoutes));
  if (records) await app.register(asPlugin(trendRoutes));
  if (records) await app.register(asPlugin(doctorRoutes));

  await app.ready();

  // Every test file starts with one account, so the common case needs no setup.
  if (!options.keepStore) await createTestUser();

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
