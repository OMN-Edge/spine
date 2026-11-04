import { describe, expect, it } from 'vitest';
import { classifyOpenFailure } from './open-failure';

/**
 * After the password is accepted the records can still fail to open. What the person is told depends on where it stopped, so that a
 * failure that is not the password never sends them to change it (Nov 4: a replay of the records failed and the screen said the master
 * password was wrong).
 */
const at = new Date('2026-11-04T12:00:00.000Z');

describe('why the records did not open', () => {
  it('is the key when the core says the key did not open (its class does not cross the worker, its name does)', () => {
    expect(classifyOpenFailure(Object.assign(new Error('could not open'), { name: 'OpenError' }), 'opening the vault', at).kind).toBe('key');
  });

  it('is the vault when the connection or the server failed, or the core had not yet the list of records', () => {
    expect(classifyOpenFailure(new TypeError('Load failed'), '', at).kind).toBe('vault');
    expect(classifyOpenFailure(Object.assign(new Error('request failed (503)'), { status: 503 }), 'loading profiles', at).kind).toBe('vault');
    expect(classifyOpenFailure(new Error('x'), 'opening the vault', at).kind).toBe('vault');
  });

  it('is the records when the core stopped after it had them', () => {
    const failure = classifyOpenFailure(new Error('a row of pages still clashes after the rows that held its place were removed'), 'starting the core', at);
    expect(failure.kind).toBe('records');
  });

  it('gives a report to send to support: when, what build, where it stopped and what was said, and nothing of the records or the person', () => {
    const { report } = classifyOpenFailure(Object.assign(new Error('a row of pages still clashes'), { status: 500, code: 'x' }), 'starting the core', at);
    expect(report).toContain('Time: 2026-11-04T12:00:00.000Z');
    expect(report).toContain('Failed at: vault (starting the core)');
    expect(report).toContain('Error: Error: a row of pages still clashes');
    expect(report).toContain('Status: 500 x');
    expect(report).toMatch(/^App: /m);
    expect(report).not.toMatch(/@|password|key:/i);
  });

  it('keeps a long message short', () => {
    const { report } = classifyOpenFailure(new Error('x'.repeat(5000)), 'starting the core', at);
    expect(report.length).toBeLessThan(900);
  });
});
