import { randomBytes } from 'node:crypto';
import type { BillingRepository } from 'spine-core/store/types.js';
import { InvoiceError } from '../issuer.js';
import { openText, sealText } from './seal.js';
import { readZip } from './zip.js';

/**
 * The operator's link to ANAF's e-Factura: the authorisation (OAuth2 with the operator's qualified certificate) and the four calls an invoice needs. Written from ANAF's
 * own papers, kept in `docs/reference/efactura/`: "Procedura de inregistrare aplicatii portal ANAF" (the OAuth flow, the lifetimes, the limits) and the Ministry's
 * "Prezentare servicii web" with the swagger pages (upload, uploadb2c, stareMesaj, descarcare, the xml-to-pdf service).
 *
 * How it works: once, in a browser holding the certificate (the token plugged in, or its software running), the operator opens ANAF's sign-in, which asks for the
 * certificate, and ANAF sends the browser back here with a code, which this exchanges within 60 seconds for an access token (90 days) and a refresh token (365 days).
 * After that no certificate is needed: the access token goes in each call, and a refresh (a call with the refresh token, answered with a new pair) is made well before the
 * access token ends. The pair is kept sealed in the store (`seal.ts`). If the refresh token itself ends, or ANAF refuses it, the operator authorises again.
 */
export interface AnafSettings {
  /** ANAF's test platform (`test`) or the real one (`prod`): the same sign-in serves both, only the API's path differs. */
  mode: 'test' | 'prod';
  clientId: string;
  clientSecret: string;
  /** Where ANAF sends the browser back to; it must be the exact address registered for the application, and `https`. */
  redirectUri: string;
  /** 32 bytes that seal the tokens in the store. */
  key: Buffer;
  /** For the tests; the global one otherwise. */
  fetcher?: typeof fetch;
  now?: () => Date;
}

type Tokens = Pick<BillingRepository, 'efacturaTokens' | 'efacturaSaveTokens' | 'efacturaBeginAuthorisation' | 'efacturaFinishAuthorisation'>;

const SIGN_IN = 'https://logincert.anaf.ro/anaf-oauth2/v1';
const API = 'https://api.anaf.ro';
/** The browser must come back within this, or the authorisation asked for is dropped (ANAF's own code lives 60 seconds; the person has to find the token and the PIN first). */
const PENDING_MS = 10 * 60_000;
/** A refresh is made when the access token has less than this left, so a week of failures is still a week of working. */
const REFRESH_BEFORE_MS = 14 * 86_400_000;
const DAY = 86_400_000;

export interface AnafStatus {
  authorised: boolean;
  authorisedAt: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  /** The access token ends within the time a refresh is due, or has ended. */
  refreshDue: boolean;
}

export type UploadKind = 'b2b' | 'b2c';
export interface UploadResult { ok: boolean; index: string | null; message: string }
export interface MessageState { state: 'ok' | 'nok' | 'sent' | 'rejected'; downloadId: string | null }

/** The expiry a JWT states (`exp`, seconds), or null where the text is not one. ANAF's are RS512; they are read here for their dates only, since ANAF is who they are for. */
export function expiryOf(jwt: string): Date | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
  } catch { return null; }
}

/** The attribute of the first element in ANAF's small XML answers (`<header ... stare="ok" id_descarcare="12"/>`), or null. */
const attr = (xml: string, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1] ?? null;
const errorsOf = (xml: string): string => [...xml.matchAll(/errorMessage="([^"]*)"/g)].map(m => m[1]).join('; ');
const unescapeXml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export class AnafLink {
  private refreshing: Promise<string> | null = null;
  constructor(private readonly settings: AnafSettings, private readonly store: Tokens) {}

  private now(): Date { return (this.settings.now ?? (() => new Date()))(); }
  private fetcher: typeof fetch = (input, init) => (this.settings.fetcher ?? fetch)(input, init);
  private base(): string { return `${API}/${this.settings.mode}/FCTEL/rest`; }

  // ---- The authorisation ----

  /** Where to send the operator's browser: ANAF's sign-in, which asks for the certificate. Remembers what the browser must come back with. */
  async authorisationUrl(): Promise<string> {
    const state = randomBytes(24).toString('base64url');
    await this.store.efacturaBeginAuthorisation(state, this.now().toISOString());
    const query = new URLSearchParams({ response_type: 'code', client_id: this.settings.clientId, redirect_uri: this.settings.redirectUri, token_content_type: 'jwt', state });
    return `${SIGN_IN}/authorize?${query}`;
  }

  /** The browser is back with a code: checks it is the authorisation asked for, and exchanges the code for the pair, which ANAF allows within 60 seconds. */
  async complete(code: string, state: string): Promise<void> {
    if (!(await this.store.efacturaFinishAuthorisation(state, this.now().toISOString(), PENDING_MS))) throw new InvoiceError('this authorisation was not asked for here, or took too long: start it again', false);
    await this.save(await this.tokenCall({ grant_type: 'authorization_code', code, redirect_uri: this.settings.redirectUri, token_content_type: 'jwt' }), this.now().toISOString());
  }

  async status(): Promise<AnafStatus> {
    const t = await this.store.efacturaTokens();
    if (!t) return { authorised: false, authorisedAt: null, accessExpiresAt: null, refreshExpiresAt: null, refreshDue: false };
    const now = this.now().getTime();
    return {
      authorised: Date.parse(t.refresh_expires_at) > now,
      authorisedAt: t.authorised_at, accessExpiresAt: t.access_expires_at, refreshExpiresAt: t.refresh_expires_at,
      refreshDue: Date.parse(t.access_expires_at) - now < REFRESH_BEFORE_MS,
    };
  }

  private async tokenCall(form: Record<string, string>): Promise<{ access: string; refresh: string }> {
    let res: Response;
    try {
      res = await this.fetcher(`${SIGN_IN}/token`, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Basic ${Buffer.from(`${this.settings.clientId}:${this.settings.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
    } catch (err) {
      throw new InvoiceError(`ANAF's sign-in could not be reached: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token || !body.refresh_token) {
      // `invalid_grant` is an ended or already used refresh token, and `invalid_client` the application's own data: neither passes by waiting.
      throw new InvoiceError(`ANAF refused the authorisation (${res.status}${body.error ? ` ${body.error}` : ''}${body.error_description ? `: ${body.error_description}` : ''})`, res.status >= 500 || res.status === 429, res.status);
    }
    return { access: body.access_token, refresh: body.refresh_token };
  }

  private async save(pair: { access: string; refresh: string }, authorisedAt: string): Promise<void> {
    const now = this.now();
    await this.store.efacturaSaveTokens({
      sealed: sealText(this.settings.key, JSON.stringify({ access: pair.access, refresh: pair.refresh })),
      // The dates are the tokens' own; ANAF says 90 and 365 days where a token cannot be read.
      access_expires_at: (expiryOf(pair.access) ?? new Date(now.getTime() + 90 * DAY)).toISOString(),
      refresh_expires_at: (expiryOf(pair.refresh) ?? new Date(now.getTime() + 365 * DAY)).toISOString(),
      authorised_at: authorisedAt,
      updated_at: now.toISOString(),
    });
  }

  /** The access token to use now, refreshed first where it is near its end. Several callers at once share one refresh. */
  async accessToken(): Promise<string> {
    const t = await this.store.efacturaTokens();
    if (!t) throw new InvoiceError('ANAF has not been authorised yet: the operator signs in with the certificate on the e-Factura page', true);
    const now = this.now().getTime();
    if (Date.parse(t.refresh_expires_at) <= now) throw new InvoiceError('the ANAF authorisation has ended: the operator signs in with the certificate again', true);
    const pair = JSON.parse(openText(this.settings.key, t.sealed)) as { access: string; refresh: string };
    if (Date.parse(t.access_expires_at) - now > REFRESH_BEFORE_MS) return pair.access;
    this.refreshing ??= this.refresh(t.updated_at, pair, t.authorised_at).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(seenAt: string, pair: { access: string; refresh: string }, authorisedAt: string): Promise<string> {
    try {
      const next = await this.tokenCall({ grant_type: 'refresh_token', refresh_token: pair.refresh, token_content_type: 'jwt' });
      await this.save(next, authorisedAt);
      return next.access;
    } catch (err) {
      // Another instance may have refreshed first, and ANAF gives a new refresh token with each, so ours is spent: take what it saved.
      const again = await this.store.efacturaTokens();
      if (again && again.updated_at !== seenAt) return (JSON.parse(openText(this.settings.key, again.sealed)) as { access: string }).access;
      // The access token still works until it ends: a failed refresh is the operator's to look at, not a reason to stop invoicing.
      if (again && Date.parse(again.access_expires_at) > this.now().getTime()) return pair.access;
      throw err;
    }
  }

  // ---- The calls ----

  private async call(method: 'GET' | 'POST', path: string, query: Record<string, string>, body?: string, accept = '*/*'): Promise<{ status: number; buffer: Buffer; type: string }> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetcher(`${this.base()}${path}?${new URLSearchParams(query)}`, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, accept, ...(body === undefined ? {} : { 'content-type': 'text/plain; charset=utf-8' }) },
        ...(body === undefined ? {} : { body }),
      });
    } catch (err) {
      throw new InvoiceError(`ANAF could not be reached: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') ?? '';
    // 401 and 403: the token is not accepted (ended, or the certificate has no right to this company); the operator signs in again. 429 is the limit of 1000 a minute. The WAF's page answers with 200.
    if (res.status === 401 || res.status === 403) throw new InvoiceError(`ANAF did not accept the authorisation (${res.status}): the operator signs in with the certificate again, and the certificate must have the right to this company in SPV`, true, res.status);
    if (res.status === 429 || res.status >= 500) throw new InvoiceError(`ANAF answered ${res.status}`, true, res.status);
    if (/Request Rejected/.test(buffer.subarray(0, 300).toString('utf8'))) throw new InvoiceError('ANAF\'s firewall refused the request (Request Rejected): something in the file it does not take', false, 200);
    return { status: res.status, buffer, type };
  }

  /**
   * ANAF's own test service for a token (`TestOauth`, in its OAuth procedure): it asks nothing of e-Factura and answers 200 with what it was sent when the token is accepted, so it
   * says whether the authorisation works before an invoice depends on it. The answer's text is not kept or shown (it echoes the token and the certificate's serial); only whether
   * ANAF took the token, and whether it saw a certificate with it.
   */
  async hello(): Promise<{ ok: boolean; status: number | null; message: string; certificateSeen: boolean }> {
    let token: string;
    try { token = await this.accessToken(); } catch (err) { return { ok: false, status: null, message: err instanceof Error ? err.message : String(err), certificateSeen: false }; }
    let res: Response;
    try {
      res = await this.fetcher(`${API}/TestOauth/jaxrs/hello?${new URLSearchParams({ name: 'Spine' })}`, { signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, accept: '*/*' } });
    } catch (err) {
      return { ok: false, status: null, message: `ANAF could not be reached: ${err instanceof Error ? err.message : String(err)}`, certificateSeen: false };
    }
    const text = (await res.text().catch(() => '')).slice(0, 4000);
    const taken = res.status === 200 && !/Request Rejected/.test(text.slice(0, 300));
    return {
      ok: taken, status: res.status, certificateSeen: taken && /serial_certificate/.test(text),
      message: taken ? '' : res.status === 401 || res.status === 403 ? 'ANAF did not accept the token: sign in with the certificate again' : `ANAF answered ${res.status}`,
    };
  }

  /**
   * ANAF's own check of a file against the rules it will apply (`validare`, OAuth procedure and API presentation: `FACT1` for an invoice, `FCN` for a credit note), made before the
   * upload so that a file it would refuse is not sent. It documents the production address only; it takes nothing in and makes nothing, so it is asked there in either mode. It
   * refuses only on ANAF's clear word (`stare` is `nok`, with its messages); a check that cannot be made, or an answer that cannot be read, is `unknown` and the upload goes on,
   * since the upload says the same if the file is wrong.
   */
  async validate(xml: string, standard: 'FACT1' | 'FCN'): Promise<{ result: 'ok' } | { result: 'refused'; message: string } | { result: 'unknown' }> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetcher(`${API}/prod/FCTEL/rest/validare/${standard}`, {
        method: 'POST', signal: AbortSignal.timeout(30_000), body: xml,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'text/plain; charset=utf-8' },
      });
    } catch { return { result: 'unknown' }; }
    if (res.status !== 200) return { result: 'unknown' };
    let body: { stare?: unknown; Messages?: unknown };
    try { body = JSON.parse((await res.text()).slice(0, 100_000)) as typeof body; } catch { return { result: 'unknown' }; }
    if (body.stare === 'ok') return { result: 'ok' };
    if (body.stare !== 'nok') return { result: 'unknown' };
    const messages = Array.isArray(body.Messages) ? body.Messages.map(m => (m && typeof (m as { message?: unknown }).message === 'string' ? (m as { message: string }).message : '')).filter(Boolean) : [];
    return { result: 'refused', message: messages.length ? messages.join('; ') : 'ANAF\'s check refused the file' };
  }

  /** Sends an invoice or a credit note (`standard` UBL or CN), as business or as a person (`uploadb2c`); false with ANAF's own words where it did not take the file. */
  async upload(xml: string, cif: string, standard: 'UBL' | 'CN', kind: UploadKind): Promise<UploadResult> {
    const { status, buffer } = await this.call('POST', kind === 'b2c' ? '/uploadb2c' : '/upload', { standard, cif }, xml);
    const text = buffer.toString('utf8');
    if (status >= 400 && !text.includes('ExecutionStatus')) return { ok: false, index: null, message: `ANAF answered ${status}: ${text.slice(0, 200)}` };
    if (attr(text, 'ExecutionStatus') === '0' && attr(text, 'index_incarcare')) return { ok: true, index: attr(text, 'index_incarcare'), message: '' };
    return { ok: false, index: null, message: errorsOf(text) || text.slice(0, 200) };
  }

  /** Where a file ANAF took has got to: `sent` (still deciding), `ok` (taken: the buyer has it), `nok` (it has errors: the download says which), `rejected` (it never took the file). */
  async state(index: string): Promise<MessageState> {
    const { buffer } = await this.call('GET', '/stareMesaj', { id_incarcare: index });
    const text = buffer.toString('utf8');
    const stare = attr(text, 'stare');
    if (stare === 'ok' || stare === 'nok') return { state: stare, downloadId: attr(text, 'id_descarcare') };
    if (stare === 'in prelucrare') return { state: 'sent', downloadId: null };
    if (stare && stare.startsWith('XML cu erori')) return { state: 'rejected', downloadId: null };
    throw new InvoiceError(`ANAF's answer about the file was not understood: ${errorsOf(text) || text.slice(0, 200)}`, true);
  }

  /** ANAF's answer for a file: what it holds in the zip, which is the invoice and the Ministry's signature (a taken file) or the errors (a refused one). Allowed ten times a day for each message. */
  async download(id: string): Promise<{ zip: Buffer; files: Map<string, Buffer> }> {
    const { buffer } = await this.call('GET', '/descarcare', { id });
    // An answer that is not a zip is ANAF's JSON error: "S-au facut deja 10 descarcari" and the like.
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new InvoiceError(`ANAF's download was not a file: ${buffer.toString('utf8').slice(0, 200)}`, true);
    return { zip: buffer, files: readZip(buffer) };
  }

  /** The errors in a refused file's download, in ANAF's words. */
  static errorsFrom(files: Map<string, Buffer>): string {
    for (const [name, content] of files) {
      if (/^semnatura/i.test(name)) continue;
      const text = content.toString('utf8');
      const found = errorsOf(text);
      if (found) return unescapeXml(found);
      return unescapeXml(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 500);
    }
    return '';
  }
}

/** The PDF of an invoice, made by the Ministry's own converter from the XML ANAF would take: a public service that needs no authorisation (`xmltopdf` swagger). */
export async function pdfOf(xml: string, kind: 'invoice' | 'credit', fetcher: typeof fetch = fetch): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetcher(`https://webservicesp.anaf.ro/prod/FCTEL/rest/transformare/${kind === 'credit' ? 'FCN' : 'FACT1'}`, {
      method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'text/plain; charset=utf-8', accept: 'application/pdf' }, body: xml,
    });
  } catch (err) {
    throw new InvoiceError(`ANAF's PDF service could not be reached: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok || buffer.subarray(0, 4).toString('latin1') !== '%PDF') throw new InvoiceError(`ANAF's PDF service did not return a PDF (${res.status}): ${buffer.subarray(0, 200).toString('utf8')}`, res.status >= 500 || res.status === 429, res.status);
  return buffer;
}
