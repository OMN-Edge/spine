import type { HttpApp } from '../http.js';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { shareHost } from '../share-host.js';
import { CardError, EMPTY_CARD, cardIsEmpty, cardText, normaliseCard, publicCard, type CardContent } from '../emergency.js';

/**
 * The owner's emergency card (FR-EMG, CR-EMG-01, SECURITY.md **M-47**): what is written on it, turning it on and off, and who opened it.
 * Owner only, and answered from the owner's own device. Turning it on seals the card on the device and sends it to the server as a bundle
 * of its own kind; the address and key stay in the owner's records, and the key never goes to the server.
 */
/** A card not looked at for this long is asked about (and the owner is mailed once a year). */
export const REVIEW_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

export async function emergencyRoutes(app: HttpApp) {
  app.addHook('preHandler', requireAuth);

  const view = async (userId: string) => {
    const store = getStore();
    const row = await store.emergency.get(userId);
    const content: CardContent = row ? normaliseCard(JSON.parse(row.content || '{}')) : EMPTY_CARD;
    const host = shareHost();
    return {
      card: content,
      updated_at: row?.updated_at ?? null,
      reviewed_at: row?.reviewed_at ?? row?.updated_at ?? null,
      // A card that is on and was last looked at a year ago or more: the page asks the owner to check it is still right.
      review_due: !!row?.card_id && Date.now() - Date.parse(row.reviewed_at ?? row.updated_at) > REVIEW_AFTER_MS,
      published: row?.card_id && row.card_key && host ? { id: row.card_id, address: host.addressOf(row.card_id, row.card_key), since: row.published_at } : null,
      // The card as others read it, as the plain text an offline code holds, and what did not fit: only the details turned on are in it.
      offline: cardText(publicCard(content)),
      scans: await store.emergency.scans(userId, 50),
    };
  };

  app.get('/api/emergency', async (req, reply) => reply.header('Cache-Control', 'no-store').send(await view(req.userId)));

  // Writes what is on the card. A card that is on is sent again, so the address already handed out shows the new words.
  app.put<{ Body: unknown }>('/api/emergency', async (req, reply) => {
    let card: CardContent;
    try { card = normaliseCard(req.body); } catch (err) { return reply.status(400).send({ error: err instanceof CardError ? err.message : 'not a card' }); }
    const store = getStore();
    const now = new Date().toISOString();
    await store.emergency.save(req.userId, JSON.stringify(card), now);
    const row = await store.emergency.get(req.userId);
    const host = shareHost();
    if (row?.card_id && row.card_key && host) {
      try {
        await host.publishCard({ id: row.card_id, key: row.card_key, content: JSON.stringify(publicCard(card)) });
      } catch {
        return reply.status(502).send({ error: 'the card was saved here but could not be sent; it will be sent when you save again', code: 'not_sent' });
      }
    }
    return reply.send(await view(req.userId));
  });

  // Turns the card on: sealed and sent, under a new id and key the first time.
  app.post('/api/emergency/publish', async (req, reply) => {
    const host = shareHost();
    if (!host) return reply.status(503).send({ error: 'this device cannot publish a card', code: 'no_share_host' });
    const store = getStore();
    const row = await store.emergency.get(req.userId);
    const card = row ? normaliseCard(JSON.parse(row.content || '{}')) : EMPTY_CARD;
    if (cardIsEmpty(publicCard(card))) return reply.status(400).send({ error: 'write something on the card first', code: 'empty' });
    try {
      const made = await host.publishCard({ id: row?.card_id ?? null, key: row?.card_key ?? null, content: JSON.stringify(publicCard(card)) });
      await store.emergency.setPublished(req.userId, made, new Date().toISOString());
    } catch (err) {
      const code = (err as { code?: string }).code;
      return reply.status(code === 'too_many_cards' ? 409 : 502).send({ error: code === 'too_many_cards' ? 'too many cards are on; turn one off first' : 'the card could not be sent; try again', code: code ?? 'not_sent' });
    }
    return reply.send(await view(req.userId));
  });

  // The owner looked and it is still right: the year starts over here and at the server (which mails once a year about a card not looked at).
  app.post('/api/emergency/reviewed', async (req, reply) => {
    const store = getStore();
    const row = await store.emergency.get(req.userId);
    if (!row) return reply.status(404).send({ error: 'there is no card' });
    await store.emergency.markReviewed(req.userId, new Date().toISOString());
    const host = shareHost();
    if (row.card_id && host) await host.reviewCard(row.card_id).catch(() => undefined); // the page still shows it as reviewed; the next save tells the server
    return reply.send(await view(req.userId));
  });

  // After taking a profile at eighteen: the card the old owner's account published for it becomes this account's, so the printed code keeps
  // working and can be replaced or turned off from here (SECURITY.md M-51). Said again harmlessly if it already is.
  app.post('/api/emergency/take-over', async (req, reply) => {
    const row = await getStore().emergency.get(req.userId);
    const host = shareHost();
    if (!row?.card_id || !host) return reply.send(await view(req.userId));
    try { await host.takeCard(row.card_id); } catch { return reply.status(502).send({ error: 'the card could not be taken over; try again', code: 'not_sent' }); }
    return reply.send(await view(req.userId));
  });

  // A new code for the card, when the old one is lost: the old address is turned off first (a lost card must stop opening before anything
  // else), then the card is sent again under a new id and key. The offline code, if one was printed, cannot be replaced: it is the card itself.
  app.post('/api/emergency/replace', async (req, reply) => {
    const host = shareHost();
    if (!host) return reply.status(503).send({ error: 'this device cannot publish a card', code: 'no_share_host' });
    const store = getStore();
    const row = await store.emergency.get(req.userId);
    if (!row?.card_id) return reply.status(409).send({ error: 'the card is not on', code: 'not_on' });
    const card = normaliseCard(JSON.parse(row.content || '{}'));
    try { await host.revokeCard(row.card_id); } catch { return reply.status(502).send({ error: 'the old code could not be turned off; nothing was changed', code: 'not_sent' }); }
    await store.emergency.setPublished(req.userId, null, new Date().toISOString());
    try {
      const made = await host.publishCard({ id: null, key: null, content: JSON.stringify(publicCard(card)) });
      await store.emergency.setPublished(req.userId, made, new Date().toISOString());
    } catch {
      // The old code is already dead and the card is off: the page says so, and the owner turns it on again.
      return reply.status(502).send({ error: 'the old code is turned off, but the new one could not be made; turn the card on again', code: 'old_off' });
    }
    return reply.send(await view(req.userId));
  });

  // Turns it off: the sealed copy is deleted at the server and the address stops opening. A card already seen may have been copied.
  app.delete('/api/emergency/publish', async (req, reply) => {
    const store = getStore();
    const row = await store.emergency.get(req.userId);
    const host = shareHost();
    if (row?.card_id) {
      if (!host) return reply.status(503).send({ error: 'this device cannot turn the card off', code: 'no_share_host' });
      try { await host.revokeCard(row.card_id); } catch { return reply.status(502).send({ error: 'the card could not be turned off; try again', code: 'not_sent' }); }
    }
    await store.emergency.setPublished(req.userId, null, new Date().toISOString());
    return reply.send(await view(req.userId));
  });
}
