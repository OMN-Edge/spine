import { publicUrl } from './config.js';

/**
 * Where passkeys belong: the relying party is this site. A passkey made on one host does not work on another, which is the point
 * (a look-alike site cannot ask for it). The id is the hostname of `SPINE_DOMAIN` and the origin the address people type; on a
 * developer's machine both are `localhost`.
 */
export function relyingParty(env: NodeJS.ProcessEnv = process.env): { id: string; origin: string; name: string } {
  const origin = new URL(publicUrl('/', env)).origin;
  return { id: new URL(origin).hostname, origin, name: 'Spine' };
}
