import { nativeTools, type NativeTools } from '../native-tools.js';

export * from './signatures-parse.js';

/** The doctors named by stamps on the last pages of a PDF. Done by the host's tool (`native-tools.ts`). */
export const readSignatures: NativeTools['readSignatures'] = (filePath, lastPages, maxPagePixels) => nativeTools().readSignatures(filePath, lastPages, maxPagePixels);

/** The people whose digital signatures in a PDF still hold. Done by the host's tool (`native-tools.ts`). */
export const readDigitalSigners: NativeTools['readDigitalSigners'] = filePath => nativeTools().readDigitalSigners(filePath);
