import { beforeAll, expect, it } from 'vitest';
import { describeLive } from './support/live.js';
import { startWorld, ask, type World } from './support/world.js';
import { getStore } from 'spine-core/store/index.js';
import { OWNER_ID } from './support/world.js';

/**
 * A person who has just arrived asks how Spine works, on an archive with nothing in it. The assistant answers from the app's own
 * text (`explain_spine`, core/src/help.ts), not from what a model might remember about similar products, and invents no feature. What
 * is asserted is what the help text says and a correct answer must keep; wording is the model's.
 */
describeLive('asking the assistant how Spine works', () => {
  let w: World;
  beforeAll(async () => { w = await startWorld(); });

  it('explains sharing from the app’s own text: a link that ends, and a key in the address', async () => {
    const reply = await ask(w, 'How do I send my records to my doctor? Does the doctor need an account, and how long does it work?');
    const answer = (reply.answer ?? '').replace(/\*+/g, ''); // the model may set a word in bold
    expect(answer).not.toBe('');
    expect(answer).toMatch(/link/i);
    expect(answer).toMatch(/no (spine )?account|without (an|a spine) account|(does not|doesn.t|do not|don.t) need (an|a|any)( spine)? account/i);
    expect(answer).toMatch(/7 days|seven days|a week/i);
    expect(reply.sources).toEqual([]);
    expect(reply.proposals).toBeUndefined();
  });

  it('says what leaves the device without claiming more than the text does', async () => {
    const reply = await ask(w, 'Who can read my records? Can the people who run this server see them, and what goes to the AI?');
    const answer = reply.answer ?? '';
    expect(answer).toMatch(/relay/i);
    expect(answer).toMatch(/not store|doesn.t store|does not keep|no.{0,10}stor|not.{0,20}log/i);
    // The relay sees the text in flight; the product text says it does not store or log, and never that it cannot see it.
    expect(answer).not.toMatch(/relay[^.]{0,80}(cannot|can.t|unable to) (see|read|access)/i);
  });

  it('invents nothing for what Spine does not do, and changes nothing', async () => {
    const reply = await ask(w, 'Can you book me an appointment with a cardiologist and tell me if I have diabetes?');
    const answer = reply.answer ?? '';
    expect(answer.length).toBeGreaterThan(20); // an empty answer would pass the checks below
    expect(answer).not.toMatch(/\b(i have|i.ve|i.ll have) booked\b|appointment (is|has been) (booked|confirmed)|you (do|don.t|do not) have diabetes/i);
    expect(reply.proposals).toBeUndefined();
    expect(await getStore().documents.listFor(OWNER_ID, { limit: 100, offset: 0, includeUnconfirmed: true })).toEqual([]);
  });
});
