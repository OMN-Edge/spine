import type { HttpApp } from '../http.js';
import { getStore, type MeasurementPoint } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { DOC_TYPE_GUIDES } from '../llm/doc-types.js';
import { unitKey } from '../units.js';

/**
 * Values over time. A trend is only meaningful between values in the same unit: 13.5 g/dL and
 * 135 g/L are one hemoglobin but not one line. So a series reports the unit most of its numeric
 * values use (spelling aside) and marks the points that can be drawn with it; the rest are listed, not charted.
 */
export async function trendRoutes(app: HttpApp) {
  app.addHook('preHandler', requireAuth);

  // Every test with a value, with its latest.
  app.get('/api/measurements', async (req, reply) => {
    return reply.send(await getStore().measurements.names(req.userId));
  });

  // One test's values, oldest first. The name is in the query because test names carry spaces and slashes.
  app.get<{ Querystring: { name?: string } }>('/api/measurements/series', async (req, reply) => {
    const canonical = typeof req.query.name === 'string' ? req.query.name.trim().toLowerCase() : '';
    if (!canonical) return reply.status(400).send({ error: 'name is required' });

    const series = buildSeries(canonical, await getStore().measurements.series(req.userId, canonical));
    if (!series) return reply.status(404).send({ error: 'not found' });
    return reply.send(series);
  });

  // A test called something else everywhere. A name another test has makes the two one.
  app.post<{ Body: { from?: unknown; to?: unknown } }>('/api/measurements/rename', async (req, reply) => {
    const from = typeof req.body?.from === 'string' ? req.body.from.trim().toLowerCase() : '';
    const to = req.body?.to;
    if (!from) return reply.status(400).send({ error: 'from is required' });
    if (typeof to !== 'string' || to.trim() === '' || to.length > 120) return reply.status(400).send({ error: 'to must be a name of 1 to 120 characters' });
    const result = await getStore().measurements.renameTest(req.userId, from, to);
    if (result === 'not_found') return reply.status(404).send({ error: 'not found' });
    if (result === 'same') return reply.status(400).send({ error: 'that is already its name' });
    if (result === 'invalid') return reply.status(400).send({ error: 'to must have something in it' });
    return reply.send({ result, canonical: to.trim().replace(/\s+/g, ' ').toLowerCase() });
  });

  // Every value of a test is removed (the documents stay).
  app.delete<{ Querystring: { name?: string } }>('/api/measurements', async (req, reply) => {
    const canonical = typeof req.query.name === 'string' ? req.query.name.trim().toLowerCase() : '';
    if (!canonical) return reply.status(400).send({ error: 'name is required' });
    const removed = await getStore().measurements.removeTest(req.userId, canonical);
    if (removed === 0) return reply.status(404).send({ error: 'not found' });
    return reply.send({ removed });
  });

  // Two names for one test become one: `from` is folded into `into` and remembered for later documents.
  app.post<{ Body: { from?: unknown; into?: unknown } }>('/api/measurements/merge', async (req, reply) => {
    const name = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
    const from = name(req.body?.from);
    const into = name(req.body?.into);
    if (!from || !into) return reply.status(400).send({ error: 'from and into are required' });
    const result = await getStore().measurements.mergeTests(req.userId, from, into);
    if (result === 'same') return reply.status(400).send({ error: 'a test cannot be merged into itself' });
    if (result === 'not_found') return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true, canonical: into });
  });

  // What the review form offers for each type of document: the same list the model was given.
  app.get('/api/document-types', async (_req, reply) => {
    return reply.send(
      Object.entries(DOC_TYPE_GUIDES).map(([type, g]) => ({ type, label: g.label, fields: g.fields, grouped: g.grouped ?? [] })),
    );
  });
}

/**
 * One test's points as the chart and table want them: the unit they share, and which can be drawn. Shared by the owner's
 * trends and a share link's, which differ only in which points they pass in.
 */
export function buildSeries(canonical: string, points: MeasurementPoint[]) {
  if (points.length === 0) return null;
  const unit = commonUnit(points);
  const key = unitKey(unit);
  const drawable = (p: MeasurementPoint) => p.value_num !== null && p.taken_on !== null && unitKey(p.unit) === key;

  // A consultation often quotes values a lab report already holds: the same test, day and value.
  // Draw it once, from the report that has a reference range (or the first), and list the rest.
  const winner = new Map<string, MeasurementPoint>();
  for (const p of points.filter(drawable)) {
    const at = `${p.taken_on}|${p.value_num}`;
    const held = winner.get(at);
    if (!held || (held.ref_low === null && held.ref_high === null && (p.ref_low !== null || p.ref_high !== null))) winner.set(at, p);
  }
  return {
    canonical,
    name: points[points.length - 1].name,
    unit,
    points: points.map(p => {
      const isDrawable = drawable(p);
      const repeat = isDrawable && winner.get(`${p.taken_on}|${p.value_num}`) !== p;
      return { ...p, charted: isDrawable && !repeat, repeat };
    }),
  };
}

/** The unit most of a test's numeric values are in (spelling aside); ties go to the newest value's, as printed. */
function commonUnit(points: MeasurementPoint[]): string | null {
  const counts = new Map<string | null, { n: number; shown: string | null }>();
  for (const p of points) {
    if (p.value_num === null) continue;
    const key = unitKey(p.unit);
    counts.set(key, { n: (counts.get(key)?.n ?? 0) + 1, shown: p.unit ?? null });
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const { n, shown } of counts.values()) if (n >= bestCount) { best = shown; bestCount = n; }
  return best;
}
