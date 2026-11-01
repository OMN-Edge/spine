import plugin from 'tailwindcss/plugin.js';
import defaultColors from 'tailwindcss/colors.js';

// One palette for the whole app: warm paper-to-ink greys and one teal, `brand`, and the few hues the screens use for states. Screens use
// these names, never a colour of their own, so the look changes here. brand-600 is the main colour (5.5:1 with white); gray-500 is the
// lightest grey for text (4.8:1 on gray-50).
//
// Every colour is a CSS variable, set below for the light theme (`:root`) and for the dark one (`[data-theme='dark']`, which public/theme.js
// sets from the person's choice or their device). The dark theme is each scale read the other way: a screen that says bg-gray-50 and
// text-gray-900 gets the page's dark and light, bg-brand-50 a dark teal tint, text-brand-600 a lighter teal, bg-red-50 a dark red tint.
// Nothing is written twice, so a screen needs no `dark:` classes.
const brand = {
  50: '#effaf8', 100: '#d3f2ec', 200: '#a7e4da', 300: '#6dcfc0', 400: '#2fb3a2',
  500: '#14958a', 600: '#0f766e', 700: '#0d5f59', 800: '#0e4c48', 900: '#0f3c39',
};
const gray = {
  50: '#faf8f4', 100: '#f3f1ec', 200: '#e7e4dd', 300: '#d5d1c9', 400: '#a3a099',
  500: '#716e68', 600: '#57554f', 700: '#42413d', 800: '#27282c', 900: '#16181d', 950: '#0c0d10',
};

/** For each shade, the light shade it shows in the dark theme. The neutrals mirror around the middle (so gray-500 text, the lightest grey
 *  allowed on the page, becomes the darkest allowed on dark); the state hues put their tints on the darkest end, so a warning is a dark
 *  amber panel with pale text and not a bright one. */
const NEUTRAL = { 50: 900, 100: 800, 200: 700, 300: 600, 400: 500, 500: 400, 600: 300, 700: 200, 800: 100, 900: 50, 950: 50 };
const HUE = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 500, 500: 400, 600: 300, 700: 200, 800: 100, 900: 50, 950: 50 };

const HUES = ['red', 'orange', 'amber', 'yellow', 'green', 'emerald', 'sky', 'indigo', 'purple'];
const scales = {
  brand: [brand, NEUTRAL],
  gray: [gray, NEUTRAL],
  ...Object.fromEntries(HUES.map(h => [h, [defaultColors[h], HUE]])),
};

const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(' ');

const colors = {};
const light = {};
const dark = {};
for (const [name, [scale, mirror]] of Object.entries(scales)) {
  colors[name] = {};
  for (const shade of Object.keys(scale)) {
    const v = `--c-${name}-${shade}`;
    colors[name][shade] = `rgb(var(${v}) / <alpha-value>)`;
    light[v] = channels(scale[shade]);
    dark[v] = channels(scale[mirror[shade]] ?? scale[shade]);
  }
}

// White is the surface of cards and fields (and the text on a strong button, which is dark when the button is light); `snow` stays white
// for what is dark in both themes: the page viewer, the camera, the handles over a photo.
colors.white = 'rgb(var(--c-white) / <alpha-value>)';
colors.snow = '#ffffff';
light['--c-white'] = '255 255 255';
dark['--c-white'] = '30 32 37';

// The public pages' own colours (the front page, how it works, protection, families), as channels so an opacity applies: a mist paper and a
// deep teal ink rather than the app's greys, the app's teal as the accent, `surface` for what is drawn as a page, and `honey`, the one warm
// note, used only where a value is marked as on paper with a highlighter. `band` is a section dark in both themes.
colors.paper = 'rgb(var(--paper) / <alpha-value>)';
colors.ink = 'rgb(var(--ink) / <alpha-value>)';
colors.accent = { DEFAULT: 'rgb(var(--accent) / <alpha-value>)', light: 'rgb(var(--accent-light) / <alpha-value>)' };
colors.band = 'rgb(var(--band) / <alpha-value>)';
colors.surface = 'rgb(var(--surface) / <alpha-value>)';
colors.honey = 'rgb(var(--honey) / <alpha-value>)';
colors['band-fg'] = 'rgb(var(--band-fg) / <alpha-value>)';
Object.assign(light, { '--paper': '245 247 246', '--surface': '255 255 255', '--ink': '23 41 42', '--accent': '15 118 110', '--accent-light': '94 234 212', '--honey': '242 193 78', '--band': '23 41 42', '--band-fg': '245 247 246' });
Object.assign(dark, { '--paper': '16 24 25', '--surface': '24 35 36', '--ink': '234 241 240', '--accent': '111 211 196', '--accent-light': '111 211 196', '--honey': '227 179 65', '--band': '10 16 17', '--band-fg': '234 241 240' });

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors,
      fontFamily: {
        sans: ['"Inter Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif', '"Apple Color Emoji"', '"Segoe UI Emoji"'],
        display: ['Literata', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => addBase({
      ':root': { 'color-scheme': 'light', ...light },
      "[data-theme='dark']": { 'color-scheme': 'dark', ...dark },
    })),
  ],
};
