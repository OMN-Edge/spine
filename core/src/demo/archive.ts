import type { ManifestFile } from '../archive/manifest.js';
import type { LinkKind } from '../store/types.js';

/**
 * The sample archive (FR-ACC-03): what the demo loads. The documents are invented (no real person, clinic or number), drawn as PDFs like a clinic's own, and arrive with what reading them would
 * have found (the details, the results over time, the doctors), the links and episodes a person would have curated, and the translations of what the app translates (written by hand), so the
 * demo shows everything the app does with no model and nothing leaving the host. It is made when the web app is built (`web/scripts/demo-archive.mjs`, from `core/src/testing/clinic/`) and fetched
 * when someone asks for the sample, so the files are not kept in the repository and are not downloaded by anyone who does not.
 */
export type DemoLanguage = 'en' | 'ro' | 'fr' | 'de';
export const DEMO_LANGUAGES: readonly DemoLanguage[] = ['en', 'ro', 'fr', 'de'];

/** What a translation of one document holds, by the text it translates (the title and summary, and each value, test name and specialty as the document has it). */
export interface DemoTranslation {
  title: string;
  summary: string;
  fields: Record<string, string>;
  measurements: Record<string, string>;
  doctors: Record<string, string>;
}

export interface DemoRecord {
  /** What the document is called in the archive: also the name of its file, `<key>.pdf`. */
  key: string;
  pdf: string;
  file: ManifestFile;
  /** The document is in Romanian; these are what a reader in each of the others is shown. */
  translations: Partial<Record<Exclude<DemoLanguage, 'ro'>, DemoTranslation>>;
}

export interface DemoLink { from: string; to: string; kind: LinkKind; state: 'proposed' | 'confirmed'; source: 'auto' | 'owner' }
export interface DemoEpisode {
  /** As the owner would name it, in each language; a suggested episode has none. */
  title: Record<DemoLanguage, string> | null;
  state: 'proposed' | 'confirmed';
  documents: string[];
}

export interface DemoArchive { records: DemoRecord[]; links: DemoLink[]; episodes: DemoEpisode[] }

/** Where the archive comes from: the device fetches the files its build made; a test gives it from the script. */
export interface DemoSource {
  archive(): Promise<DemoArchive>;
  pdf(name: string): Promise<Uint8Array>;
}

let current: DemoSource | null = null;
export function useDemoSource(source: DemoSource | null): void { current = source; }
export function demoSource(): DemoSource {
  if (!current) throw new Error('the sample archive has no source: the host gives one with useDemoSource() before the sample records are asked for');
  return current;
}
