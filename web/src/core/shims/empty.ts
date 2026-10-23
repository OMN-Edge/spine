/** Stand-in for a Node-only package whose users are replaced on the device. Anything that actually calls it fails loudly. */
const refuse = (name: string) => () => { throw new Error(`${name} is not available on the device`); };
export default {};
export const createRequire = () => refuse('require');
export class ChatVertexAI { constructor() { refuse('ChatVertexAI')(); } }
export class ChatAnthropic { constructor() { refuse('ChatAnthropic')(); } }
export class GoogleAuth { constructor() { refuse('GoogleAuth')(); } }
export const hash = refuse('argon2 hash');
export const verify = refuse('argon2 verify');
export const Algorithm = { Argon2d: 0, Argon2i: 1, Argon2id: 2 };
