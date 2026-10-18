import type { FastifyInstance, FastifyReply } from 'fastify';
import { exportArchive, exportDocument, type ExportZip } from '../archive/export.js';
import { logger } from '../logger.js';
import { requireAuth, requireRecentAuth } from './middleware.js';

/** The zip is built while it is sent, so a large archive never sits whole in memory. */
function sendZip(reply: FastifyReply, zip: ExportZip) {
  zip.stream.on('error', err => logger.warn('an export failed while it was being sent', { error: err instanceof Error ? err.message : String(err) }));
  return reply
    .header('content-type', 'application/zip')
    .header('content-disposition', `attachment; filename="${zip.filename}"`)
    .header('cache-control', 'no-store')
    .send(zip.stream);
}

export async function exportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // One document, trimmed to its own pages, with what was read from it.
  app.get<{ Params: { id: string } }>('/api/documents/:id/export', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const result = await exportDocument(req.userId, req.params.id);
    if (result === 'not_found') return reply.status(404).send({ error: 'not found' });
    if (result === 'no_pages') return reply.status(409).send({ error: 'every page of this document is hidden' });
    if (result === 'cannot_trim') return reply.status(500).send({ error: 'could not prepare the pages of this document' });
    return sendZip(reply, result);
  });

  // Everything the person has.
  app.get('/api/export', { preHandler: requireRecentAuth, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const result = await exportArchive(req.userId);
    if (result === 'empty') return reply.status(404).send({ error: 'there is nothing to export yet' });
    return sendZip(reply, result);
  });
}
