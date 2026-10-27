/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // One palette for the whole app: warm paper-to-ink greys and one teal, `brand`. Screens use these names, never a colour of their own,
      // so the look changes here. brand-600 is the main colour (5.5:1 with white); gray-500 is the lightest grey for text (4.8:1 on gray-50).
      colors: {
        brand: {
          50: '#effaf8', 100: '#d3f2ec', 200: '#a7e4da', 300: '#6dcfc0', 400: '#2fb3a2',
          500: '#14958a', 600: '#0f766e', 700: '#0d5f59', 800: '#0e4c48', 900: '#0f3c39',
        },
        gray: {
          50: '#faf8f4', 100: '#f3f1ec', 200: '#e7e4dd', 300: '#d5d1c9', 400: '#a3a099',
          500: '#716e68', 600: '#57554f', 700: '#42413d', 800: '#27282c', 900: '#16181d', 950: '#0c0d10',
        },
        // The landing page's names for the same colours, as channels in index.css so an opacity applies.
        paper: 'rgb(var(--paper) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        accent: { DEFAULT: 'rgb(var(--accent) / <alpha-value>)', light: 'rgb(var(--accent-light) / <alpha-value>)' },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif', '"Apple Color Emoji"', '"Segoe UI Emoji"'],
        label: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
