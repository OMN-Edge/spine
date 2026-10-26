import { describe, it, expect } from 'vitest';
import { NATIVE_TOOL_NAMES } from 'spine-core/native-tools.js';
import { nodeTools } from '../native/index.js';

/** The Node version of every tool the shared code asks for is there, and there is no other (a tool missing here fails when a test first needs it). */
describe('the server’s tools', () => {
  it('are exactly the tools the shared code asks for', () => {
    expect(Object.keys(nodeTools).sort()).toEqual([...NATIVE_TOOL_NAMES].sort());
    for (const name of NATIVE_TOOL_NAMES) expect(typeof nodeTools[name], name).toBe('function');
  });
});
