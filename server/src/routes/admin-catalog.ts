import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth, requireRecentAuth } from 'spine-core/routes/middleware.js';
import { logger } from 'spine-core/logger.js';
import { loadBillingConfig } from '../billing/config.js';
import { billingProvider } from '../billing/provider.js';
import { CatalogError, drift, loadCatalog, publish, setPrice, setProduct, type Period } from 'spine-billing/products.js';
import { adoptConfigured, configuredPrices, CURRENCY, PROVIDER_PREFIX, SPINE_PRODUCTS } from '../plans/products.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * The product catalog on the admin page (`billing/products.ts`): an administrator edits what is commercial (the name, the description, whether a product is on sale, each amount), sends
 * it to the payment provider, and sees where the provider differs. Changes ask for a recent sign-in, as the other changes to what is sold do, and none is silent: each is logged.
 */
export async function adminCatalogRoutes(app: FastifyInstance, onlyAdmins: Guard) {
  const enabled = () => { const c = loadBillingConfig(); return c.enabled ? c : null; };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof CatalogError) return reply.status(err.status).send({ error: err.message });
    throw err;
  };

  app.get('/api/admin/catalog', { preHandler: [requireAuth, onlyAdmins] }, async (_req, reply) => {
    const config = enabled();
    if (!config) return reply.header('Cache-Control', 'no-store').send({ enabled: false });
    const provider = billingProvider(config);
    const products = await loadCatalog(SPINE_PRODUCTS, provider);
    const links = await getAccountsStore().catalog.links(provider.id);
    const adoptable = configuredPrices(config).filter(f => !links.some(l => l.provider_price_id === f.providerPriceId)).length;
    return reply.header('Cache-Control', 'no-store').send({
      enabled: true, provider: provider.id, environment: config.environment, canPublish: !!provider.catalog, currency: CURRENCY, adoptable,
      products: products.map(p => ({
        id: p.id, name: p.name, description: p.description, on_sale: p.on_sale === 1, in_step: p.inStep, periods: p.template.periods,
        prices: p.prices.map(v => ({ period: v.period, currency: v.currency, amount_minor: v.current.amount_minor, version: v.current.version, sent: v.providerPriceId !== null, earlier: v.earlier.map(e => ({ version: e.version, amount_minor: e.amount_minor })) })),
      })),
    });
  });

  app.put<{ Params: { id: string }; Body: { name?: unknown; description?: unknown; on_sale?: unknown } }>('/api/admin/catalog/:id', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    if (!enabled()) return reply.status(404).send({ error: 'this instance has no plans' });
    const { name, description, on_sale } = req.body ?? {};
    if ((name !== undefined && typeof name !== 'string') || (description !== undefined && description !== null && typeof description !== 'string') || (on_sale !== undefined && typeof on_sale !== 'boolean')) return reply.status(400).send({ error: 'name, description and on_sale are a text, a text or null, and true or false' });
    try {
      await setProduct(SPINE_PRODUCTS, req.params.id, { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(on_sale !== undefined ? { onSale: on_sale } : {}) });
    } catch (err) { return fail(reply, err); }
    logger.info('a product was changed', { event: 'catalog_product', product: req.params.id, account: req.userId });
    return reply.send({ ok: true });
  });

  app.put<{ Params: { id: string }; Body: { period?: unknown; amount_minor?: unknown } }>('/api/admin/catalog/:id/price', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    if (!enabled()) return reply.status(404).send({ error: 'this instance has no plans' });
    const { period, amount_minor } = req.body ?? {};
    if (typeof period !== 'string' || typeof amount_minor !== 'number') return reply.status(400).send({ error: 'a period and an amount in cents are needed' });
    try {
      const price = await setPrice(SPINE_PRODUCTS, req.params.id, period as Period, CURRENCY, amount_minor);
      logger.info('a price was set', { event: 'catalog_price', product: req.params.id, period, version: price.version, account: req.userId });
      return reply.send({ ok: true, version: price.version });
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/admin/catalog/publish', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth], config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const config = enabled();
    if (!config) return reply.status(404).send({ error: 'this instance has no plans' });
    try {
      const reports = await publish(SPINE_PRODUCTS, billingProvider(config), { prefix: PROVIDER_PREFIX });
      logger.info('the catalog was sent to the payment provider', { event: 'catalog_publish', account: req.userId, failed: reports.filter(r => r.state === 'failed').length });
      return reply.header('Cache-Control', 'no-store').send({ reports });
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/admin/catalog/adopt', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth], config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const config = enabled();
    if (!config) return reply.status(404).send({ error: 'this instance has no plans' });
    try {
      const adopted = await adoptConfigured(config);
      logger.info('the prices named in the environment were taken into the catalog', { event: 'catalog_adopt', account: req.userId, adopted });
      return reply.send({ adopted });
    } catch (err) {
      if (err instanceof CatalogError) return fail(reply, err);
      logger.warn('the prices named in the environment could not be read', { reason: err instanceof Error ? err.message : String(err) });
      return reply.status(502).send({ error: 'the payment provider could not be asked about its prices' });
    }
  });

  app.post('/api/admin/catalog/check', { preHandler: [requireAuth, onlyAdmins], config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const config = enabled();
    if (!config) return reply.status(404).send({ error: 'this instance has no plans' });
    return reply.header('Cache-Control', 'no-store').send({ differences: await drift(SPINE_PRODUCTS, billingProvider(config)) });
  });
}
