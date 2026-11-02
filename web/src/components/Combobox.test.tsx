import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES, INTERFACE_LANGUAGES } from 'spine-core/languages';
import { Combobox } from './Combobox';
import { LANGUAGES, screensIn } from '../i18n';

/**
 * The app's one dropdown is typed into only where that helps: a long list, or one that takes something new. A short fixed list is a button
 * that opens the same list, so there is no box to type into that clears when it opens.
 */
const options = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
const draw = (props: Partial<Parameters<typeof Combobox>[0]> & { n: number }) =>
  renderToStaticMarkup(<Combobox ariaLabel="Pick" value="v1" onChange={() => undefined} options={options(props.n)} {...props} />);

describe('the dropdown', () => {
  it('is chosen from, not typed into, when the list is short and fixed', () => {
    const html = draw({ n: 3 });
    expect(html).toContain('<button');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('Option 1');
    expect(html).not.toContain('<input');
  });

  it('is typed into when the list is long, or when something new can be added', () => {
    expect(draw({ n: 9 })).toContain('<input');
    expect(draw({ n: 2, newLabel: name => `Use ${name}` })).toContain('<input');
  });
});

describe('the languages on offer', () => {
  it('are every language documents are translated into, the four the screens are written in first', () => {
    expect(LANGUAGES.map(l => l.code).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
    expect(LANGUAGES.slice(0, INTERFACE_LANGUAGES.length).map(l => [l.code, l.screens])).toEqual(INTERFACE_LANGUAGES.map(code => [code, true]));
    expect(LANGUAGES.filter(l => !l.screens).length).toBe(SUPPORTED_LANGUAGES.length - INTERFACE_LANGUAGES.length);
  });

  it('show the screens in English where they are not written in the language', () => {
    expect(screensIn('it')).toBe('en');
    expect(screensIn('ja')).toBe('en');
    expect(screensIn('ro')).toBe('ro');
    expect(screensIn('en')).toBe('en');
  });
});
