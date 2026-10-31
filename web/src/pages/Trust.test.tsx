import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const SHA = 'a'.repeat(40);

async function render(commit: string): Promise<string> {
  vi.resetModules();
  vi.doMock('../build-info', () => ({ BUILD_COMMIT: commit }));
  const { default: Trust } = await import('./Trust');
  return renderToStaticMarkup(<MemoryRouter><Trust /></MemoryRouter>);
}

describe('the page that says how to check the app', () => {
  it('names the commit the build says, in full', async () => {
    const html = await render(SHA);
    expect(html).toContain(SHA);
    expect(html).not.toContain('not published');
  });

  it('says so when the build carries changes that are not published', async () => {
    expect(await render(`${SHA}-dirty`)).toContain('not a release');
  });

  it('claims no commit when the build does not say one', async () => {
    for (const commit of ['dev', 'unknown']) {
      const html = await render(commit);
      expect(html).toContain('nothing to compare it with');
      expect(html).not.toMatch(/at commit/);
    }
  });

  it('says what a check cannot promise', async () => {
    expect(await render(SHA)).toContain('cannot prove that the site is honest');
  });
});
