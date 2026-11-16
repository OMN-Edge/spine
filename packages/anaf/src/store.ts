/**
 * What the ANAF code asks of the store, written here and not taken from Spine's: the sealed authorisation, the numbering, and the documents with how far each has got. Spine's
 * store has these methods with these shapes (the wiring in `billing/invoicing/queue.ts` is checked by the compiler), and a service of its own would give its database the same
 * ones; nothing of Spine's is imported (S15).
 */
/** The authorisation ANAF gave: the access and refresh tokens sealed as one string (AES-GCM; the key is not in the store), and when each ends. */
export interface AnafTokens {
  sealed: string;
  access_expires_at: string;
  refresh_expires_at: string;
  authorised_at: string;
  updated_at: string;
}

export type DocumentKind = 'invoice' | 'credit';

/** A numbered invoice or credit note and how far it has got with ANAF. The XML is kept, and the signed answer ANAF gives, which it keeps for 60 days only. */
export interface StoredDocument {
  draft_id: string;
  kind: DocumentKind;
  series: string;
  number: number;
  issue_date: string;
  /** The draft id of the invoice a credit note reverses. */
  reverses: string | null;
  xml: string | null;
  /** What the document was made from (the issuer's own JSON), so a credit note, or the same invoice made again after ANAF refused it, is made from the same data. */
  input: string | null;
  /** ANAF's upload index, once it has the file. */
  anaf_index: string | null;
  /** `sent` (ANAF has it, undecided), `ok`, `nok`, or `abroad` (the buyer is outside Romania: nothing to send). */
  anaf_state: 'sent' | 'ok' | 'nok' | 'abroad' | null;
  anaf_message: string | null;
  /** ANAF's answer as it sent it (a zip: the invoice and the Ministry's signature), base64. */
  signed: string | null;
  created_at: string;
  updated_at: string;
}

export type DocumentPatch = Partial<Pick<StoredDocument, 'xml' | 'input' | 'anaf_index' | 'anaf_state' | 'anaf_message' | 'signed'>>;

export interface TokenStore {
  efacturaTokens(): Promise<AnafTokens | null>;
  efacturaSaveTokens(tokens: AnafTokens): Promise<void>;
  efacturaBeginAuthorisation(state: string, at: string): Promise<void>;
  /** Whether `state` was asked for here and is not older than `maxAgeMs`; spent by the asking. */
  efacturaFinishAuthorisation(state: string, now: string, maxAgeMs: number): Promise<boolean>;
}

export interface DocumentStore {
  /** The next number in the series, for a draft that has none; the same document again for a draft that has one. */
  efacturaReserve(draftId: string, kind: DocumentKind, series: string, issueDate: string, at: string, reverses: string | null): Promise<StoredDocument>;
  efacturaDocument(draftId: string): Promise<StoredDocument | null>;
  efacturaUpdateDocument(draftId: string, patch: DocumentPatch, at: string): Promise<void>;
  efacturaDocuments(limit: number): Promise<StoredDocument[]>;
}

export type AnafStore = TokenStore & DocumentStore;
