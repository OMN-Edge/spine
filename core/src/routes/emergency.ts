import type { HttpApp } from '../http.js';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { shareHost } from '../share-host.js';
import { CardError, EMPTY_CARD, cardIsEmpty, cardText, normaliseCard, type CardContent } from '../emergency.js';

/**
 * The owner's emergency card (FR-EMG, CR-EMG-01, SECURITY.md **M-47**): what is written on it, turning it on and off, and who opened it.
 * Owner only, and answered from the owner's own device. Turning it on seals the card on the device and sends it to the server as a bundle
 * of its own kind; the address and key stay in the owner's records, and the key never goes to the server.
 */
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
      published: row?.card_id && row.card_key && host ? { id: row.card_id, address: host.addressOf(row.card_id, row.card_key), since: row.published_at } : null,
      // The same card as the plain text an offline code holds, and what did not fit.
      offline: cardText(content),
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
        await host.publishCard({ id: row.card_id, key: row.card_key, content: JSON.stringify(card) });
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
    if (cardIsEmpty(card)) return reply.status(400).send({ error: 'write something on the card first', code: 'empty' });
    try {
      const made = await host.publishCard({ id: row?.card_id ?? null, key: row?.card_key ?? null, content: JSON.stringify(card) });
      await store.emergency.setPublished(req.userId, made, new Date().toISOString());
    } catch (err) {
      const code = (err as { code?: string }).code;
      return reply.status(code === 'one_card' ? 409 : 502).send({ error: code === 'one_card' ? 'there is a card already; turn it off first' : 'the card could not be sent; try again', code: code ?? 'not_sent' });
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
