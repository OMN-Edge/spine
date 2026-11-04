import { describe, it, expect } from 'vitest';
import { relayAllowances } from '../relay/serve.js';

describe("the relay's daily allowances", () => {
  it('are 500 for an account, 200 for a share link, 40 for a demo visitor and 400 for every visitor together', () => {
    expect(relayAllowances({})).toEqual({ dailyCalls: 500, dailySharedCalls: 200, dailyDemoCalls: 40, dailyDemoTotalCalls: 400 });
  });

  it('read 0 alike, as none: there is no unlimited', () => {
    // Nov 4: an account's and a share's 0 gave the default of 500 while the demo's gave none.
    const zero = { SPINE_RELAY_DAILY_CALLS: '0', SPINE_RELAY_SHARE_DAILY_CALLS: '0', SPINE_RELAY_DEMO_DAILY_CALLS: '0', SPINE_RELAY_DEMO_TOTAL_DAILY_CALLS: '0' };
    expect(relayAllowances(zero)).toEqual({ dailyCalls: 0, dailySharedCalls: 0, dailyDemoCalls: 0, dailyDemoTotalCalls: 0 });
  });

  it('take a whole number as it is, and give the default for anything else', () => {
    expect(relayAllowances({ SPINE_RELAY_DAILY_CALLS: '5000' }).dailyCalls).toBe(5000);
    for (const bad of ['', 'lots', '-5', '2.5']) expect(relayAllowances({ SPINE_RELAY_DAILY_CALLS: bad }).dailyCalls).toBe(500);
  });
});
