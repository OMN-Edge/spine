import { nativeTools, type NativeTools } from '../native-tools.js';

/** Text on A4 pages in a font that has the accents of the languages Spine speaks. Done by the host's tool (`native-tools.ts`). */
export const textToPdf: NativeTools['textToPdf'] = (text, outPath) => nativeTools().textToPdf(text, outPath);
