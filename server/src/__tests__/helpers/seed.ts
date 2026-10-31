import { v4 as uuidv4 } from 'uuid';
import { getStore, getAccountsStore } from 'spine-core/store/index.js';
import { hashPassword } from '../../passwords.js';
import type { DocType } from 'spine-core/types.js';
import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from '../../legal.js';

/**
 * The account every test file starts with. A fixed id, so tests that do not care
 * about ownership can name it without looking it up.
 */
export const OWNER_ID = 'user-owner';
export const OWNER_EMAIL = 'owner@spine.test';
export const TEST_PASSWORD = 'a-long-test-password';

/** Creates an account. The default owner is created by `buildTestApp`. */
export async function createTestUser(
  email = OWNER_EMAIL,
  options: { id?: string; password?: string; verified?: boolean; consent?: boolean; approved?: boolean } = {},
): Promise<{ id: string; email: string; password: string }> {
  const id = options.id ?? (email === OWNER_EMAIL ? OWNER_ID : uuidv4());
  const password = options.password ?? TEST_PASSWORD;
  await getAccountsStore().users.create({
    id,
    email,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
    verifiedAt: options.verified === false ? null : new Date().toISOString(),
    approved: options.approved,
    // Most tests are not about consent: their accounts have given it, as a person who signed up would have.
    consent: options.consent === false ? undefined : { healthVersion: HEALTH_CONSENT_VERSION, termsVersion: TERMS_VERSION },
  });
  return { id, email, password };
}

/**
 * Fixtures go through the store interface, not raw SQL.
 *
 * P10: a fixture that builds state by a route the production code does not use
 * proves less than one that does. It also means the interface has to be complete
 * enough to express every fixture — when it is not, that is a finding about the
 * interface rather than a reason to reach past it.
 */

export async function seedSourceFile(
  overrides: {
    id?: string;
    userId?: string;
    checksum?: string;
    status?: 'pending' | 'processing' | 'done' | 'error';
    mimeType?: string;
    filePath?: string;
    photoSet?: boolean;
    fromExport?: boolean;
    sample?: boolean;
  } = {},
) {
  const store = getStore();
  const id = overrides.id ?? uuidv4();
  const userId = overrides.userId ?? OWNER_ID;

  await store.sourceFiles.create(userId, {
    id,
    uploadedAt: new Date().toISOString(),
    originalFilename: 'scan.pdf',
    filePath: overrides.filePath ?? '/tmp/x.pdf',
    mimeType: overrides.mimeType ?? 'application/pdf',
    checksum: overrides.checksum ?? uuidv4(),
    photoSet: overrides.photoSet,
    fromExport: overrides.fromExport,
    sample: overrides.sample,
  });

  if (overrides.status && overrides.status !== 'pending') {
    await store.sourceFiles.setStatus(userId, id, overrides.status);
  }
  return id;
}

export async function seedPage(
  sourceFileId: string,
  overrides: {
    id?: string;
    userId?: string;
    pageNumber?: number;
    imagePath?: string;
    rawText?: string;
  } = {},
) {
  const id = overrides.id ?? uuidv4();
  await getStore().pages.create(overrides.userId ?? OWNER_ID, {
    id,
    sourceFileId,
    pageNumber: overrides.pageNumber ?? 1,
    imagePath: overrides.imagePath ?? '/tmp/p.png',
    imageWidth: 800,
    imageHeight: 1100,
    rawText: overrides.rawText ?? 'page text',
    elements: [],
    extractionSource: 'native_text',
    isContinuation: null,
    continuationConfidence: null,
    continuationReasoning: null,
  });
  return id;
}

export async function seedDocument(
  overrides: {
    userId?: string;
    sourceFileId?: string;
    docDate?: string | null;
    provider?: string | null;
    docType?: DocType;
    aiSummary?: string;
    tags?: string[];
    withPage?: boolean;
  } = {},
) {
  const store = getStore();
  const userId = overrides.userId ?? OWNER_ID;
  const sourceFileId =
    overrides.sourceFileId ?? (await seedSourceFile({ userId, status: 'done' }));
  const pageId = overrides.withPage === false ? null : await seedPage(sourceFileId, { userId });
  const id = uuidv4();

  await store.documents.create(userId, {
    id,
    sourceFileId,
    pageStart: 1,
    pageEnd: 1,
    docDate: overrides.docDate === undefined ? '2026-01-15' : overrides.docDate,
    provider: overrides.provider === undefined ? 'Clinica Aurora' : overrides.provider,
    docType: overrides.docType ?? 'lab_result',
    aiSummary: overrides.aiSummary ?? 'A lab result.',
  });

  if (overrides.tags?.length) {
    await store.tags.setForDocument(userId, id, overrides.tags);
  }

  return { id, sourceFileId, pageId };
}

export async function seedShareLink(overrides: {
  userId?: string;
  /** The link's id, which is the address a recipient's request names (default: a new one). */
  id?: string;
  scope?: string;
  scopeValue?: string | null;
  expiresAt?: string;
  revoked?: boolean;
  includeScans?: boolean;
  language?: string | null;
  requireApproval?: boolean;
  allowChat?: boolean;
}) {
  const store = getStore();
  const id = overrides.id ?? uuidv4();
  const userId = overrides.userId ?? OWNER_ID;

  await store.shareLinks.create(userId, {
    id,
    label: null,
    scope: (overrides.scope ?? 'all') as 'all' | 'tag' | 'document_ids' | 'date_range',
    scopeValue: overrides.scopeValue ?? null,
    createdAt: new Date().toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
    includeScans: overrides.includeScans ?? false,
    language: overrides.language ?? null,
    requireApproval: overrides.requireApproval ?? false,
    allowChat: overrides.allowChat ?? false,
  });

  if (overrides.revoked) await store.shareLinks.revoke(userId, id);
  return id;
}
