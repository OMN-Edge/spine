import type { FastifyInstance } from 'fastify';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { normaliseLicenseCode } from '../doctors.js';

const LIMITS = { name: 120, specialty: 80, clinic: 120, licenseCode: 40 };
const text = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max ? value : null);

/**
 * The doctors a user has met on their documents. The directory is built by reading documents;
 * these routes let the owner correct it: rename, fill in a specialty or clinic, merge two entries
 * for one person, remove one nothing refers to.
 */
export async function doctorRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/doctors', async (req, reply) => reply.send(await getStore().doctors.listFor(req.userId)));

  app.get<{ Params: { id: string } }>('/api/doctors/:id', async (req, reply) => {
    const store = getStore();
    const doctor = await store.doctors.find(req.userId, req.params.id);
    if (!doctor) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ...doctor, documents: await store.doctors.documentsFor(req.userId, doctor.id) });
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown; specialty?: unknown; clinic?: unknown; license_code?: unknown } }>(
    '/api/doctors/:id',
    async (req, reply) => {
      const body = req.body ?? {};
      const unknown = Object.keys(body).filter(k => !['name', 'specialty', 'clinic', 'license_code'].includes(k));
      if (unknown.length > 0) return reply.status(400).send({ error: `unknown field(s): ${unknown.join(', ')}` });

      const change: { name?: string; specialty?: string | null; clinic?: string | null; licenseCode?: string | null } = {};
      if (body.name !== undefined) {
        const name = text(body.name, LIMITS.name);
        if (name === null || name.trim() === '') return reply.status(400).send({ error: `a name is 1 to ${LIMITS.name} characters` });
        change.name = name.trim();
      }
      for (const key of ['specialty', 'clinic'] as const) {
        if (body[key] === undefined) continue;
        const value = body[key] === null || body[key] === '' ? '' : text(body[key], LIMITS[key]);
        if (value === null) return reply.status(400).send({ error: `${key} is at most ${LIMITS[key]} characters` });
        change[key] = value.trim() || null;
      }

      if (body.license_code !== undefined) {
        const raw = body.license_code === null ? '' : text(body.license_code, LIMITS.licenseCode);
        if (raw === null) return reply.status(400).send({ error: `a code is at most ${LIMITS.licenseCode} characters` });
        const code = normaliseLicenseCode(raw);
        // Emptied is allowed (it clears the code); something typed that is too short to identify anyone is not.
        if (raw.trim() !== '' && code === null) return reply.status(400).send({ error: 'a professional code is at least 4 letters or digits' });
        change.licenseCode = code;
      }

      const result = await getStore().doctors.update(req.userId, req.params.id, change);
      if (result === 'not_found') return reply.status(404).send({ error: 'not found' });
      if (result === 'code_taken') return reply.status(409).send({ error: 'another doctor already has that code; merge them instead' });
      if (result === 'name_taken') return reply.status(409).send({ error: 'another doctor already has that name; merge them instead' });
      return reply.send({ ok: true });
    },
  );

  // Two entries for one person become one: `from` goes into this doctor.
  app.post<{ Params: { id: string }; Body: { from?: unknown } }>('/api/doctors/:id/merge', async (req, reply) => {
    const from = req.body?.from;
    if (typeof from !== 'string' || !from) return reply.status(400).send({ error: 'from is required' });
    if (from === req.params.id) return reply.status(400).send({ error: 'a doctor cannot be merged into themselves' });
    // Both must be the user's; a doctor that is not is reported as not found.
    if (!(await getStore().doctors.merge(req.userId, from, req.params.id))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/doctors/:id', async (req, reply) => {
    const store = getStore();
    if (!(await store.doctors.find(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    if (!(await store.doctors.remove(req.userId, req.params.id))) {
      return reply.status(409).send({ error: 'documents still name this doctor; merge them into another entry instead' });
    }
    return reply.status(204).send();
  });
}
