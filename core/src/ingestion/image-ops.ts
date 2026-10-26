import { nativeTools, type NativeTools } from '../native-tools.js';

/**
 * The three things done to a picture with an image library. They are here, apart from the callers, because each host does them with its own
 * (the server's tests with sharp, the device with the browser's image and canvas support) and the callers are the same on both.
 */
export interface UprightOptions { maxSide: number; maxPixels: number }

export const uprightPng: NativeTools['uprightPng'] = (src, dest, options) => nativeTools().uprightPng(src, dest, options);
export const uprightJpeg: NativeTools['uprightJpeg'] = (src, options) => nativeTools().uprightJpeg(src, options);
export const rotateImage: NativeTools['rotateImage'] = (src, dest, degrees) => nativeTools().rotateImage(src, dest, degrees);
