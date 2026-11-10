import { existsSync, readFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getAccountsStore } from 'spine-core/store/index.js';
import { sharedLimits } from '../config.js';
import { accountEntitlements, liveSharesFor } from '../billing/entitlements.js';
import { BLOB_NAME, SHARE_ID, blobNames, readBlob, removeBlob, removeBlobs, removeShare, streamBlob, streamBundle, writeBlob, writeBundle } from '../shared-files.js';
import { readSlots } from '../read-slots.js';
import { readBudget } from '../read-budget.js';
import { spaceFor } from '../disk-space.js';

/** The most page images one share may hold. */
const MAX_BLOBS = 10_000;
import { requireAuth } from 'spine-core/routes/middleware.js';
import { countryOf } from '../geo.js';
import { accessRequestMail, cardOpenedMail, cardReviewMail } from '../accounts.js';
import { getMailer } from '../mail/index.js';
import { publicUrl } from 'spine-core/config.js';
import { issueToken } from '../relay/token.js';
import { relaySettings, relayEnv } from './relay.js';
import { windowLimiter } from '../rate-limit.js';
import { logger } from 'spine-core/logger.js';

/** What a failure of something done after the answer, with nobody waiting on it, leaves: a line, with the reason and no content. */
const later = (what: string) => (err: unknown) => logger.warn(`${what} failed`, { error: err instanceof Error ? err.message : String(err) });

/**
 * The server's part of an encrypted share (SECURITY.md M-36, docs/crypto-design.md stage 4). A link is a sealed copy of what it
 * shares, which the owner's device makes and uploads; the key is in the address after the `#` (or reaches one browser, wrapped to its
 * own key, when the owner approves), so **this side can open nothing**. It stores the bytes, ends them on time and on revoke, relays
 * the approval handshake, and notes where in the world and when the link was opened. Nothing here reads a record.
 *
 * The owner's routes need a session; the public ones are known only by the random id in the link and answer only with metadata and
 * sealed bytes. Rate limits are options so tests drive the real ones.
 */
export interface SharedRouteOptions {
  requestPerSource?: { max: number; timeWindow: string };
  requestPerLink?: { max: number; windowMs: number };
  readPerSource?: { max: number; timeWindow: string };
}

/** Requests waiting on one link at once. */
const MAX_WAITING = 5;
/** A row of a link that ended stays this long, so a late visitor is told it ended and the owner's device can still collect what happened. */
export const ENDED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

const VISITOR_KEY = /^[A-Za-z0-9_-]{43}$/;
const WRAPPED = /^[A-Za-z0-9_-]{60,400}$/;
/** The value a share's key makes for its pass: a 32-byte hash, base64url. */
const PASS_CHECK = /^[A-Za-z0-9_-]{43}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DOC_ID = /^[A-Za-z0-9-]{1,64}$/;
const PASS_MS = 10 * 60 * 1000;
/**
 * A share's pass is short: the relay cannot ask whether the link was revoked, so a pass already handed out works until it ends. The page asks
 * again as it goes (a pass is renewed with a minute left), and once the link is revoked or expired it is refused one.
 */
/** A card has no end of its own; this is the time the store holds for it. Its owner turns it off. */
const CARD_NO_END = '9999-12-31T00:00:00.000Z';
const CARD_MAX_BYTES = 64 * 1024;
const CARD_REVIEW_MS = 365 * 24 * 60 * 60 * 1000;
/** An owner is told of a card being opened at most this often, however often it is. */
const CARD_MAIL_EVERY_MS = 15 * 60 * 1000;
const cardMailed = new Map<string, number>();

export const SHARE_PASS_MS = 2 * 60 * 1000;

/**
 * The yearly reminder about an emergency card (FR-EMG-08): the owner of a card not sent or reviewed for a year is mailed once, neutrally, and
 * again a year after that if still nothing. The server knows only the date; it cannot see what is on the card. With no mailer nothing is
 * sent (the page asks the owner itself). Run at start and hourly.
 */
export async function remindCardReviews(now = new Date()): Promise<number> {
  const mailer = getMailer();
  if (!mailer.enabled) return 0;
  const store = getAccountsStore();
  const year = new Date(now.getTime() - CARD_REVIEW_MS).toISOString();
  let sent = 0;
  for (const due of await store.shared.cardsToRemind(year, year)) {
    const owner = await store.users.findById(due.userId);
    if (!owner) continue;
    // Marked first: a mail that fails is not tried every hour, and the next year's reminder is the retry.
    await store.shared.markReminded(due.id, now.toISOString());
    await mailer.send(cardReviewMail(owner.email)).then(() => { sent++; }, () => undefined);
  }
  return sent;
}

/** Deletes the files of every share that has ended, and the rows long after. Run at start, hourly, and by a visit to an ended one. */
export async function sweepShares(now = new Date()): Promise<number> {
  const store = getAccountsStore();
  const ended = await store.shared.endedWithFiles(now.toISOString());
  for (const { id } of ended) await removeShare(id);
  await store.shared.forgetEnded(now.toISOString(), ENDED_GRACE_MS);
  return ended.length;
}

export async function sharedRoutes(app: FastifyInstance, opts: SharedRouteOptions = {}) {
  // Sealed bytes arrive as the body, as they are.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: sharedLimits().partBytes }, (_req, body, done) => done(null, body));

  /**
   * Whether a request shows what only the share's key makes (S-48, S-54). The id is in every address and in logs, so it proves nothing; a copy
   * made before the value existed has none to check and ends within the month a share can last.
   */
  const showsKey = (bundle: { passCheck: string | null }, given: unknown): boolean => {
    if (!bundle.passCheck) return true;
    const a = Buffer.from(typeof given === 'string' ? given : '');
    const b = Buffer.from(bundle.passCheck);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /**
   * Sends a sealed copy or page image as a stream (S-58), with no more reads of one share open at once from one source than that source may
   * have, so the copy is never held whole in memory however often it is asked for.
   */
  const sendSealed = async (req: { ip?: string; log: { error: (o: unknown, m: string) => void } }, reply: import('fastify').FastifyReply, what: string, open: () => Promise<{ body: import('node:stream').Readable; size: number } | null>) => {
    const release = readSlots.take(`${what}:${req.ip ?? ''}`);
    if (!release) return reply.status(429).send({ error: 'too many reads are open at once; try again in a moment', code: 'too_many_reads' });
    let opened: Awaited<ReturnType<typeof open>>;
    try { opened = await open(); } catch (err) { release(); throw err; }
    if (!opened) { release(); return reply.status(404).send({ error: 'not found' }); }
    // In bytes an hour for this source and share, so a known id does not let one source pull a large copy again and again (S-57).
    if (!readBudget.take(`${what}:${req.ip ?? ''}`, opened.size)) {
      opened.body.destroy();
      release();
      return reply.status(429).send({ error: 'this has been read a great deal from here; try again later', code: 'read_budget' });
    }
    opened.body.once('close', release);
    opened.body.on('error', err => req.log.error({ err }, 'a sealed copy could not be read to the end'));
    return reply.type('application/octet-stream').header('content-length', String(opened.size)).header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow').send(opened.body);
  };

  const live = async (id: string) => {
    if (!SHARE_ID.test(id)) return null;
    const bundle = await getAccountsStore().shared.get(id);
    if (!bundle) return null;
    if (bundle.revokedAt || Date.parse(bundle.expiresAt) <= Date.now()) {
      // Ended: nothing of it should be left on disk, whenever this is noticed.
      if (bundle.size > 0 || bundle.blobs > 0) void sweepShares().catch(later('removing an ended share'));
      return 'ended' as const;
    }
    return bundle;
  };

  // ── The owner's ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  app.put<{ Params: { id: string }; Body: Buffer }>('/api/shared/:id', { preHandler: requireAuth }, async (req, reply) => {
    const limits = sharedLimits();
    const { id } = req.params;
    // The emergency card: one sealed bundle with no end of its own, outside the plan's share limits (it is on every plan), small, and never waiting for approval.
    if (req.headers['x-spine-kind'] === 'card') {
      if (!SHARE_ID.test(id) || !Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > CARD_MAX_BYTES) return reply.status(400).send({ error: 'an id and a sealed card of at most 64 KB are needed' });
      if (!(await spaceFor(req.body.length))) return reply.status(507).send({ error: 'the server is short of room just now; try again later', code: 'storage_low' });
      const cardCheck = req.headers['x-spine-pass-check'];
      if (cardCheck !== undefined && (typeof cardCheck !== 'string' || !PASS_CHECK.test(cardCheck))) return reply.status(400).send({ error: 'the pass check is not in the expected form' });
      const put = await getAccountsStore().shared.put(req.userId, { id, expiresAt: CARD_NO_END, requireApproval: false, size: req.body.length, blobs: 0, blobBytes: 0, kind: 'card', passCheck: cardCheck ?? null }, new Date().toISOString());
      if (put === 'too_many_cards') return reply.status(409).send({ error: 'too many cards are on; turn one off first', code: 'too_many_cards' });
      if (put !== 'ok') return reply.status(put === 'taken' ? 404 : 409).send({ error: put === 'taken' ? 'not found' : 'this card was turned off' });
      await writeBundle(id, req.body);
      return reply.status(201).send({ ok: true });
    }
    const expires = String(req.headers['x-spine-expires'] ?? '');
    if (!SHARE_ID.test(id) || !ISO.test(expires) || Date.parse(expires) <= Date.now() || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.status(400).send({ error: 'an id, an end time in the future and the sealed copy are needed' });
    }
    if (Date.parse(expires) - Date.now() > 31 * 24 * 60 * 60 * 1000) return reply.status(400).send({ error: 'a share may last at most 31 days' });
    const store = getAccountsStore();
    const used = await store.shared.usage(req.userId, new Date().toISOString());
    const existing = await store.shared.get(id);
    const replacing = existing && existing.userId === req.userId && !existing.revokedAt;
    // A plan with a share of its own limits how many are live, and which can wait for approval (billing off: the instance's ceiling only).
    const plan = await accountEntitlements(req.userId);
    const requireApproval = req.headers['x-spine-approval'] === '1';
    if (requireApproval && plan && !plan.approvalMode) return reply.status(402).send({ error: 'approving visitors is not part of the account’s plan', code: 'plan_required' });
    if (!replacing && used.bundles >= (await liveSharesFor(req.userId))) {
      const byPlan = plan?.liveShares != null && used.bundles >= plan.liveShares;
      return reply.status(byPlan ? 402 : 409).send({ error: byPlan ? 'another live share is not part of the account’s plan' : 'too many shares are live; revoke one first', code: byPlan ? 'plan_required' : 'too_many' });
    }
    // A device that names its page images (`x-spine-keep-images: 1`) sends the new ones first and this last, so the copy is never without
    // the pages it names: the images stay, and `blobs/keep` then removes what the new copy no longer uses. Without it (a page from before),
    // the images of the earlier copy go, and the new ones follow.
    const keep = replacing && req.headers['x-spine-keep-images'] === '1';
    if (used.bytes - (replacing ? existing.size + (keep ? 0 : existing.blobBytes) : 0) + req.body.length > limits.totalBytes) return reply.status(413).send({ error: 'the shares hold too much; revoke one first', code: 'full' });
    // What a recipient's browser must show to get the pass for its model calls: a value only the share's key makes, which the owner's device
    // sends with the copy (S-48). A copy sent again without one keeps the value it has.
    if (!(await spaceFor(req.body.length))) return reply.status(507).send({ error: 'the server is short of room just now; try again later', code: 'storage_low' });
    const passCheck = req.headers['x-spine-pass-check'];
    if (passCheck !== undefined && (typeof passCheck !== 'string' || !PASS_CHECK.test(passCheck))) return reply.status(400).send({ error: 'the pass check is not in the expected form' });
    const put = await store.shared.put(req.userId, { id, expiresAt: expires, requireApproval, size: req.body.length, blobs: keep ? existing.blobs : 0, blobBytes: keep ? existing.blobBytes : 0, passCheck: passCheck ?? null }, new Date().toISOString());
    if (put !== 'ok') return reply.status(put === 'taken' ? 404 : 409).send({ error: put === 'taken' ? 'not found' : 'this share was revoked' });
    if (!keep) await removeBlobs(id);
    await writeBundle(id, req.body);
    return reply.status(201).send({ ok: true });
  });

  // After a promotion (SECURITY.md **M-51**): the person who took a profile takes over the card the old owner's account published for it, so the
  // printed code goes on working and is theirs to replace or turn off. Only an account holding a promoted grant from the card's owner, naming its id.
  app.post<{ Params: { id: string } }>('/api/shared/:id/take', { preHandler: [requireAuth, app.rateLimit({ max: 20, timeWindow: '10 minutes' })] }, async (req, reply) => {
    if (!SHARE_ID.test(req.params.id)) return reply.status(404).send({ error: 'not found' });
    const done = await getAccountsStore().shared.take(req.userId, req.params.id, new Date().toISOString());
    if (done === 'not_found') return reply.status(404).send({ error: 'not found' });
    if (done === 'too_many') return reply.status(409).send({ error: 'too many cards are on; turn one off first', code: 'too_many_cards' });
    return reply.send({ ok: true });
  });

  // The owner says their card is still right: the year for the reminder starts over. (Sending the card again does the same.)
  app.post<{ Params: { id: string } }>('/api/shared/:id/review', { preHandler: requireAuth }, async (req, reply) => {
    if (!SHARE_ID.test(req.params.id) || !(await getAccountsStore().shared.touchCard(req.userId, req.params.id, new Date().toISOString()))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  /** The owner's own live share, or null. */
  const ownBundle = async (userId: string, id: string) => {
    const bundle = SHARE_ID.test(id) ? await getAccountsStore().shared.get(id) : null;
    return bundle && bundle.userId === userId && !bundle.revokedAt ? bundle : null;
  };

  // A page image, under the name the owner's device gave it. One sent again under the same name replaces the first, counted once.
  app.put<{ Params: { id: string; n: string }; Body: Buffer }>('/api/shared/:id/blob/:n', { preHandler: requireAuth }, async (req, reply) => {
    const limits = sharedLimits();
    const name = req.params.n;
    const store = getAccountsStore();
    const bundle = await ownBundle(req.userId, req.params.id);
    if (!bundle) return reply.status(404).send({ error: 'not found' });
    if (!BLOB_NAME.test(name) || !Buffer.isBuffer(req.body) || req.body.length === 0) return reply.status(400).send({ error: 'a name and the sealed file are needed' });
    if (!(await spaceFor(req.body.length))) return reply.status(507).send({ error: 'the server is short of room just now; try again later', code: 'storage_low' });
    const old = await readBlob(bundle.id, name);
    if (!old && bundle.blobs >= MAX_BLOBS) return reply.status(413).send({ error: 'a share holds at most 10,000 page images', code: 'full' });
    const used = await store.shared.usage(req.userId, new Date().toISOString());
    if (used.bytes - (old?.length ?? 0) + req.body.length > limits.totalBytes) return reply.status(413).send({ error: 'the shares hold too much; revoke one first', code: 'full' });
    await writeBlob(bundle.id, name, req.body);
    if (old) await store.shared.removeBlob(req.userId, bundle.id, old.length);
    await store.shared.addBlob(req.userId, bundle.id, req.body.length);
    return reply.status(201).send({ ok: true });
  });

  // Which page images the share holds, so a copy sent again sends only the ones it lacks.
  app.get<{ Params: { id: string } }>('/api/shared/:id/blobs', { preHandler: requireAuth }, async (req, reply) => {
    const bundle = await ownBundle(req.userId, req.params.id);
    if (!bundle) return reply.status(404).send({ error: 'not found' });
    return reply.header('Cache-Control', 'no-store').send({ names: await blobNames(bundle.id) });
  });

  // After a new copy: the images it names stay, every other goes, and stops counting against the account's limit.
  app.post<{ Params: { id: string }; Body: { names?: unknown } }>('/api/shared/:id/blobs/keep', { preHandler: requireAuth }, async (req, reply) => {
    const names = req.body?.names;
    if (!Array.isArray(names) || names.length > MAX_BLOBS || !names.every(n => typeof n === 'string' && BLOB_NAME.test(n))) return reply.status(400).send({ error: 'the names of the images to keep are needed' });
    const bundle = await ownBundle(req.userId, req.params.id);
    if (!bundle) return reply.status(404).send({ error: 'not found' });
    const kept = new Set(names as string[]);
    let removed = 0;
    for (const name of await blobNames(bundle.id)) {
      if (kept.has(name)) continue;
      const bytes = await readBlob(bundle.id, name);
      await removeBlob(bundle.id, name);
      if (bytes) await getAccountsStore().shared.removeBlob(req.userId, bundle.id, bytes.length);
      removed++;
    }
    return reply.send({ removed });
  });

  app.patch<{ Params: { id: string }; Body: { expires_at?: unknown; require_approval?: unknown } }>('/api/shared/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { expires_at: expires, require_approval: approval } = req.body ?? {};
    if (expires !== undefined && (typeof expires !== 'string' || !ISO.test(expires) || Date.parse(expires) <= Date.now() || Date.parse(expires) - Date.now() > 31 * 24 * 60 * 60 * 1000)) return reply.status(400).send({ error: 'expires_at must be a time within the next 31 days' });
    if (approval !== undefined && typeof approval !== 'boolean') return reply.status(400).send({ error: 'require_approval must be true or false' });
    if (approval === true && req.userId && (await accountEntitlements(req.userId))?.approvalMode === false) return reply.status(402).send({ error: 'approving visitors is not part of the account’s plan', code: 'plan_required' });
    if (!SHARE_ID.test(req.params.id) || !(await getAccountsStore().shared.update(req.userId, req.params.id, { expiresAt: expires as string | undefined, requireApproval: approval as boolean | undefined }))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/shared/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!SHARE_ID.test(req.params.id) || !(await getAccountsStore().shared.revoke(req.userId, req.params.id, new Date().toISOString()))) return reply.status(404).send({ error: 'not found' });
    await removeShare(req.params.id);
    return reply.send({ ok: true });
  });

  // What the link's visitors did, for the owner's device to collect: browsers asking to be let in, and openings. Collected once.
  app.get('/api/shared/events', { preHandler: requireAuth }, async (req, reply) => {
    const store = getAccountsStore();
    const [requests, opens] = await Promise.all([store.shared.pendingRequests(req.userId), store.shared.pendingOpens(req.userId, 500)]);
    return reply.header('Cache-Control', 'no-store').send({ requests, opens });
  });

  app.post<{ Body: { requests?: unknown; opens?: unknown } }>('/api/shared/events/ack', { preHandler: requireAuth }, async (req, reply) => {
    const { requests = [], opens = [] } = req.body ?? {};
    if (!Array.isArray(requests) || !Array.isArray(opens) || requests.length > 1000 || opens.length > 1000 || !requests.every(r => typeof r === 'string') || !opens.every(o => Number.isInteger(o))) {
      return reply.status(400).send({ error: 'ids of requests and openings are needed' });
    }
    await getAccountsStore().shared.ackRequests(req.userId, requests as string[]);
    await getAccountsStore().shared.ackOpens(req.userId, opens as number[]);
    return reply.send({ ok: true });
  });

  // The owner's device answers a browser's request: for an approval, the share key wrapped to that browser's own key.
  app.post<{ Params: { rid: string }; Body: { decision?: unknown; wrapped_key?: unknown } }>('/api/shared/requests/:rid/decision', { preHandler: requireAuth }, async (req, reply) => {
    const { decision, wrapped_key: wrapped } = req.body ?? {};
    if (decision !== 'approved' && decision !== 'denied') return reply.status(400).send({ error: 'decision must be approved or denied' });
    if (decision === 'approved' && (typeof wrapped !== 'string' || !WRAPPED.test(wrapped))) return reply.status(400).send({ error: 'an approval carries the wrapped key' });
    const done = await getAccountsStore().shared.decide(req.userId, req.params.rid, decision, decision === 'approved' ? (wrapped as string) : null, new Date().toISOString());
    if (!done) return reply.status(404).send({ error: 'not found, already answered, or the link has ended' });
    return reply.send({ ok: true });
  });

  // ── The public ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  const read = { config: { rateLimit: opts.readPerSource ?? { max: 60, timeWindow: '1 minute' } } };

  app.get<{ Params: { id: string } }>('/api/shared/:id/meta', read, async (req, reply) => {
    const bundle = await live(req.params.id);
    if (!bundle) return reply.status(404).send({ error: 'not found' });
    if (bundle === 'ended') return reply.status(410).send({ error: 'this link is no longer active', ended: true });
    return reply.header('Cache-Control', 'no-store').send({ kind: bundle.kind, expires_at: bundle.kind === 'card' ? null : bundle.expiresAt, approval: bundle.requireApproval, size: bundle.size, blobs: bundle.blobs, relay: relaySettings() !== null });
  });

  app.get<{ Params: { id: string } }>('/api/shared/:id/bundle', read, async (req, reply) => {
    const bundle = await live(req.params.id);
    if (!bundle) return reply.status(404).send({ error: 'not found' });
    if (bundle === 'ended') return reply.status(410).send({ error: 'this link is no longer active', ended: true });
    return sendSealed(req, reply, `bundle:${bundle.id}`, () => streamBundle(bundle.id));
  });

  app.get<{ Params: { id: string; n: string } }>('/api/shared/:id/blob/:n', { config: { rateLimit: opts.readPerSource ?? { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const bundle = await live(req.params.id);
    const name = req.params.n;
    if (!bundle || bundle === 'ended' || !BLOB_NAME.test(name)) return reply.status(bundle === 'ended' ? 410 : 404).send({ error: bundle === 'ended' ? 'this link is no longer active' : 'not found' });
    return sendSealed(req, reply, `blob:${bundle.id}`, () => streamBlob(bundle.id, name));
  });

  // A browser asks to be let in. It sends its own public key; on approval the owner's device wraps the share key to it, so a leaked
  // link alone opens nothing. The same browser asking again changes nothing and sends nothing.
  const perLink = windowLimiter(opts.requestPerLink ?? { max: 10, windowMs: 60 * 60 * 1000 }, req => (req.params as { id?: string }).id ?? '', 'too many requests for this link, try again later');
  app.post<{ Params: { id: string }; Body: { key?: unknown; note?: unknown } }>(
    '/api/shared/:id/access-request',
    { config: { rateLimit: opts.requestPerSource ?? { max: 10, timeWindow: '1 minute' } }, preHandler: perLink },
    async (req, reply) => {
      const bundle = await live(req.params.id);
      if (!bundle) return reply.status(404).send({ error: 'not found' });
      if (bundle === 'ended') return reply.status(410).send({ error: 'this link is no longer active', ended: true });
      const key = req.body?.key;
      if (typeof key !== 'string' || !VISITOR_KEY.test(key)) return reply.status(400).send({ error: 'a public key is needed' });
      if (!bundle.requireApproval) return reply.status(409).send({ error: 'this link does not need approval' });
      // Text from a stranger: cut short, control characters out. The owner sees it as text and it is not in the mail.
      const raw = typeof req.body?.note === 'string' ? req.body.note : '';
      const note = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || null;
      const country = await countryOf(req.ip ?? null);
      const id = uuidv4();
      const requestedAt = new Date().toISOString();
      const made = await getAccountsStore().shared.createRequest(bundle.id, { id, visitorKey: key, note, country, requestedAt }, MAX_WAITING);
      if (made === 'waiting') return reply.status(429).send({ error: 'too many requests are waiting for this link' });
      if (made === 'known') {
        // Asking again: the browser's own earlier request, found by its key.
        const again = (await getAccountsStore().shared.pendingRequests(bundle.userId)).find(r => r.bundleId === bundle.id && r.visitorKey === key);
        return reply.header('Cache-Control', 'no-store').send({ request_id: again?.id ?? null, status: again?.status ?? 'pending', known: true });
      }
      const mailer = getMailer();
      if (mailer.enabled) {
        const owner = await getAccountsStore().users.findById(bundle.userId);
        if (owner) void mailer.send(accessRequestMail(owner.email, publicUrl(`/share-requests/${id}`), requestedAt, null)).catch(later('mailing the owner about a request to open a share'));
      }
      return reply.status(202).header('Cache-Control', 'no-store').send({ request_id: id, status: 'pending' });
    },
  );

  // The browser asks what became of its request; an approval carries the share key wrapped to its own key.
  app.get<{ Params: { id: string; rid: string } }>('/api/shared/:id/access-request/:rid', read, async (req, reply) => {
    const bundle = await live(req.params.id);
    if (!bundle) return reply.status(404).send({ error: 'not found' });
    if (bundle === 'ended') return reply.status(410).send({ error: 'this link is no longer active', ended: true });
    const found = await getAccountsStore().shared.getRequest(bundle.id, req.params.rid);
    if (!found) return reply.status(404).send({ error: 'not found' });
    return reply.header('Cache-Control', 'no-store').send({ status: found.status, wrapped_key: found.status === 'approved' ? found.wrappedKey : null });
  });

  // The recipient's browser says it opened the link, or a document of it (what is in a share only it can know). Only where in the
  // world and when are kept; never an address.
  // It takes the value only the share's key makes, as the pass does, and the store keeps at most a thousand openings waiting to be collected
  // for a share, so the owner's record of who read a link cannot be filled by someone who holds only its id (S-54).
  app.post<{ Params: { id: string }; Body: { document_id?: unknown; check?: unknown } }>('/api/shared/:id/opened', { config: { rateLimit: opts.readPerSource ?? { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const bundle = await live(req.params.id);
    if (!bundle || bundle === 'ended') return reply.status(bundle === 'ended' ? 410 : 404).send({ error: bundle === 'ended' ? 'this link is no longer active' : 'not found' });
    if (!showsKey(bundle, req.body?.check)) return reply.status(403).send({ error: 'the share’s key is needed for this', code: 'share_key_needed' });
    const doc = req.body?.document_id;
    if (doc !== undefined && doc !== null && (typeof doc !== 'string' || !DOC_ID.test(doc))) return reply.status(400).send({ error: 'document_id must be an id' });
    await getAccountsStore().shared.logOpen(bundle.id, new Date().toISOString(), await countryOf(req.ip ?? null), (doc as string | null | undefined) ?? null, typeof doc === 'string');
    if (typeof doc !== 'string') await getAccountsStore().metrics.bump(bundle.kind === 'card' ? 'card_opened' : 'share_opened', new Date().toISOString().slice(0, 10)).catch(() => undefined);
    if (bundle.kind === 'card' && typeof doc !== 'string') {
      // Every opening is logged (above); the owner is mailed the first in a while, so a card shown ten times at a desk is one mail.
      const last = cardMailed.get(bundle.id) ?? 0;
      const mailer = getMailer();
      if (mailer.enabled && Date.now() - last > CARD_MAIL_EVERY_MS) {
        cardMailed.set(bundle.id, Date.now());
        const owner = await getAccountsStore().users.findById(bundle.userId);
        if (owner) void mailer.send(cardOpenedMail(owner.email, new Date().toISOString(), await countryOf(req.ip ?? null))).catch(later('mailing the owner about a card being opened'));
      }
    }
    return reply.status(204).send();
  });

  // How the recipient's browser should behave when it translates or asks a question: the same settings as the owner's device is given, with
  // the relay as the model's host. Settings only (model names, switches), nothing secret.
  app.get<{ Params: { id: string } }>('/api/shared/:id/config', read, async (req, reply) => {
    const bundle = await live(req.params.id);
    if (!bundle || bundle === 'ended') return reply.status(bundle === 'ended' ? 410 : 404).send({ error: bundle === 'ended' ? 'this link is no longer active' : 'not found' });
    const settings = relaySettings();
    // Where the footer leads is the operator's to name, relay or no relay: the recipient's core cannot read this process's environment.
    const landing = (process.env.SPINE_LANDING_URL ?? '').trim();
    return reply.header('Cache-Control', 'no-store').send({ env: { ...(landing ? { SPINE_LANDING_URL: landing } : {}), ...(settings ? relayEnv(settings) : {}) } });
  });

  // A pass for the model calls a recipient's browser makes while reading (translating, asking): good for the share's own time only,
  // counted against the share. Whoever holds the link may make them, as they may read what it shares: the id is in the address and in logs,
  // so it is not enough, and the browser shows a value only the key makes (S-48). A copy made before the value existed has none to check
  // and ends within the month a share can last.
  app.post<{ Params: { id: string }; Body: { check?: unknown } }>('/api/shared/:id/relay-token', { config: { rateLimit: opts.readPerSource ?? { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const bundle = await live(req.params.id);
    if (!bundle || bundle === 'ended') return reply.status(bundle === 'ended' ? 410 : 404).send({ error: bundle === 'ended' ? 'this link is no longer active' : 'not found' });
    // A card is read, never asked about: it has no model calls.
    if (bundle.kind === 'card') return reply.status(404).send({ error: 'not found' });
    if (!showsKey(bundle, req.body?.check)) return reply.status(403).send({ error: 'the share’s key is needed for this', code: 'share_key_needed' });
    const settings = relaySettings();
    if (!settings) return reply.status(503).send({ error: 'this instance has no relay for model calls', code: 'no_relay' });
    const left = Date.parse(bundle.expiresAt) - Date.now();
    const { token, expiresAt } = issueToken(settings.secret, `share:${bundle.id}`, Math.min(SHARE_PASS_MS, left));
    return reply.header('Cache-Control', 'no-store').send({ token, expires_at: expiresAt });
  });
}

const ENDED_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<title>Link unavailable</title></head><body>' +
  '<p>This link is no longer active.</p></body></html>';

/**
 * `GET /share/:id`, the address a recipient is given: the app shell for a share that exists (the page opens the sealed copy itself and
 * says if it ended), a plain page for one that never did. It reads no record and keeps no log; the visit is noted when the page opens
 * the copy. Registered by the server only.
 */
export async function shareShellRoutes(app: FastifyInstance, opts: { appShellPath: string }) {
  app.get<{ Params: { id: string } }>('/share/:id', async (req, reply) => {
    if (!SHARE_ID.test(req.params.id) || !(await getAccountsStore().shared.get(req.params.id))) {
      return reply.status(410).type('text/html').send(ENDED_PAGE);
    }
    if (!existsSync(opts.appShellPath)) {
      req.log.error({ appShellPath: opts.appShellPath }, 'share view requested but the web build is missing');
      return reply.status(500).type('text/html').send(ENDED_PAGE);
    }
    return reply.type('text/html').send(readFileSync(opts.appShellPath, 'utf8'));
  });
}
