/** Stand-in for a Node-only package whose users are replaced on the device. Anything that actually calls it fails loudly. */
const refuse = (name: string) => () => { throw new Error(`${name} is not available on the device`); };
export default {};
export const createRequire = () => refuse('require');
export class ChatVertexAI { constructor() { refuse('ChatVertexAI')(); } }
export class ChatAnthropic { constructor() { refuse('ChatAnthropic')(); } }
export class GoogleAuth { constructor() { refuse('GoogleAuth')(); } }
