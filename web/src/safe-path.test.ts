import { describe, it, expect } from 'vitest';
import { inAppPath, wherePersonWas } from './safe-path';

describe('where signing in may send a person', () => {
  it('follows a path of this app, with its query and fragment', () => {
    expect(inAppPath('/documents/abc')).toBe('/documents/abc');
    expect(inAppPath('/share-requests/x?y=1#z')).toBe('/share-requests/x?y=1#z');
    expect(inAppPath('/')).toBe('/');
  });

  it('does not follow anything that can mean another site', () => {
    for (const bad of ['//evil.example', '/\\evil.example', '/\\\\evil.example', '/%5Cevil.example', '/%5cevil.example', '/%2F%2Fevil.example',
      'https://evil.example', 'javascript:alert(1)', 'evil.example', '/\tevil', '/\nevil', '/%0Aevil', '/a\\b']) {
      expect(inAppPath(bad), bad).toBe('/');
    }
  });

  it('goes home for what is not a path at all', () => {
    for (const bad of [undefined, null, 5, {}, '', '/%E0%A4%A']) expect(inAppPath(bad)).toBe('/');
    expect(inAppPath('/' + 'a'.repeat(3000))).toBe('/');
  });
});

describe('where a person was going when they were sent to sign in', () => {
  it('keeps the query and the fragment, so a chosen plan is still chosen after signing in', () => {
    const was = wherePersonWas({ pathname: '/account', search: '?buy', hash: '' });
    expect(was).toBe('/account?buy');
    expect(inAppPath(was)).toBe('/account?buy');
    expect(wherePersonWas({ pathname: '/account', search: '', hash: '#shared' })).toBe('/account#shared');
  });
});
