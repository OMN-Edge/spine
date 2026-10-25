import { publicUrl } from 'spine-core/config.js';
import { useOwnerNotices } from 'spine-core/owner-notices.js';
import { accessRequestMail } from './accounts.js';
import { getMailer } from './mail/index.js';

/** The owner is mailed through the server's mailer when a browser asks to open a share (see `core/src/owner-notices.ts`). */
export function useMailedOwnerNotices(): void {
  useOwnerNotices({
    enabled: () => getMailer().enabled,
    accessRequested: (owner, requestId, requestedAt, ip) =>
      getMailer().send(accessRequestMail(owner.email, publicUrl(`/share-requests/${requestId}`), requestedAt, ip)),
  });
}
