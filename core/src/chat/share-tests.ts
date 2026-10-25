import { getStore, type MeasurementName } from '../store/index.js';
import type { Document } from '../types.js';

/**
 * The tests of the documents a link shares, and no others. The owner's `measurements.names` counts every document, and its
 * "latest" could come from one that was not shared, so a recipient's list is built from the shared documents' own results.
 * The trends routes of a share and the shared chat both use this.
 */
export async function sharedTestNames(owner: string, docs: Document[]): Promise<MeasurementName[]> {
  const byName = new Map<string, MeasurementName>();
  for (const doc of docs) {
    for (const m of await getStore().measurements.listForDocument(owner, doc.id)) {
      const held = byName.get(m.canonical);
      const newer = !held || (m.taken_on ?? '') >= (held.latest_taken_on ?? '');
      byName.set(m.canonical, {
        canonical: m.canonical,
        name: newer ? m.name : held.name,
        unit: newer ? m.unit : held.unit,
        count: (held?.count ?? 0) + 1,
        latest_value_text: newer ? m.value_text : held.latest_value_text,
        latest_taken_on: newer ? m.taken_on : held.latest_taken_on,
        latest_flag: newer ? m.flag : held.latest_flag,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
