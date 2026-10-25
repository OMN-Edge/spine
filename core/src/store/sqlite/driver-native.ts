import Native from 'better-sqlite3';
import type { OpenDatabase } from './driver.js';

/** The server's driver. The browser does not import this file, so the native module stays out of its bundle. */
export const openNative: OpenDatabase = location => new Native(location) as unknown as ReturnType<OpenDatabase>;
