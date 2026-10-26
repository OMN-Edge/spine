import { nativeTools, type NativeTools } from './native-tools.js';

/**
 * The country an address is in, from a database of address ranges, or null. A request is only ever looked up, never sent anywhere. Done by
 * the host's tool (`native-tools.ts`): the server has the ranges; a device has no address book of the world's networks and answers null.
 */
export const countryOf: NativeTools['countryOf'] = (address, env) => nativeTools().countryOf(address, env);
