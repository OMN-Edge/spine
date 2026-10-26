import { describe, it, expect } from 'vitest';
import { NATIVE_TOOL_NAMES } from 'spine-core/native-tools';
import { browserTools } from './native';

/** The browser version of every tool the shared code asks for is there, and there is no other. */
describe('the device’s tools', () => {
  it('are exactly the tools the shared code asks for', () => {
    expect(Object.keys(browserTools).sort()).toEqual([...NATIVE_TOOL_NAMES].sort());
    for (const name of NATIVE_TOOL_NAMES) expect(typeof browserTools[name], name).toBe('function');
  });
});
