import { createHash } from 'node:crypto';
import { useDigests, type Digests, type Sha256 } from '../digest.js';

/** The hashing of the tests and of the real-model suite: Node's own. The device brings libsodium's (`web/src/core/native/digests.ts`). */
export const nodeDigests: Digests = {
  sha256(): Sha256 {
    const hash = createHash('sha256');
    const self: Sha256 = { update(data) { hash.update(data); return self; }, hex: () => hash.digest('hex') };
    return self;
  },
};

export const useNodeDigests = (): void => useDigests(nodeDigests);
