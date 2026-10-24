import type { FastifyInstance } from 'fastify';
import { loadTrustAnchors } from '../trust-anchors.js';

/** The authorities the operator trusts for digital signatures, as base64 DER. Public: they are certificates, and the device checks signatures with them. */
export async function trustAnchorRoutes(app: FastifyInstance) {
  app.get('/api/trust-anchors', async (_req, reply) =>
    reply.header('Cache-Control', 'public, max-age=3600').send({ anchors: loadTrustAnchors().map(der => Buffer.from(der).toString('base64')) }));
}
