import { nativeTools, type NativeTools } from '../native-tools.js';

/** Each page of a PDF as a 200 DPI PNG under `<data>/pages/<id>/page-N.png`. Done by the host's tool (`native-tools.ts`). */
export const rasterizePdf: NativeTools['rasterizePdf'] = (sourceFileId, filePath) => nativeTools().rasterizePdf(sourceFileId, filePath);
