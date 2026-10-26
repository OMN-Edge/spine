import { nativeTools, type NativeTools } from '../native-tools.js';

/** A new PDF with only these pages of a file (their numbers in it), in the order given. Done by the host's tool (`native-tools.ts`). */
export const extractPdfPages: NativeTools['extractPdfPages'] = (source, sourcePages) => nativeTools().extractPdfPages(source, sourcePages);
