import type { PageFeatures } from './features.js';

/**
 * Pages into groups by average linkage: start with each page alone and keep joining the two groups that are alike on average,
 * while they are alike enough. A pair that cannot be one document (similarity -1: the same page number twice) never ends up in
 * a group together, and a group never grows past `maxSize`.
 */
export function clusterPages(sim: number[][], threshold: number, maxSize: number): number[][] {
  const n = sim.length;
  let groups: number[][] = Array.from({ length: n }, (_, i) => [i]);
  // Average similarity between groups, kept up to date as they merge (size-weighted).
  const avg = sim.map(row => row.slice());
  const alive = new Array<boolean>(n).fill(true);
  const size = new Array<number>(n).fill(1);
  const members: number[][] = groups.map(g => g.slice());

  for (;;) {
    let best = -Infinity; let bi = -1; let bj = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (alive[j] && avg[i][j] > best) { best = avg[i][j]; bi = i; bj = j; }
      }
    }
    if (bi < 0 || best < threshold) break;
    if (size[bi] + size[bj] > maxSize) { avg[bi][bj] = avg[bj][bi] = -Infinity; continue; }
    // Merge j into i. A pair that cannot be one document stays impossible for the merged group.
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      const merged = avg[bi][k] === -Infinity || avg[bj][k] === -Infinity || avg[bi][k] <= -1 || avg[bj][k] <= -1
        ? -Infinity
        : (size[bi] * avg[bi][k] + size[bj] * avg[bj][k]) / (size[bi] + size[bj]);
      avg[bi][k] = avg[k][bi] = merged;
    }
    members[bi].push(...members[bj]);
    size[bi] += size[bj];
    alive[bj] = false;
  }
  groups = members.filter((_, i) => alive[i]);
  return groups.map(g => g.sort((a, b) => a - b));
}

/**
 * The order to read a group's pages in: by their own "page k of N" when every page has one for the same N, otherwise as they
 * were in the file.
 */
export function readingOrder(group: number[], features: PageFeatures[]): number[] {
  const marks = group.map(i => features[i].marker);
  const total = marks[0]?.total;
  const numbered = marks.every(m => m && m.total === total) && new Set(marks.map(m => m!.index)).size === group.length;
  return [...group].sort((a, b) => numbered ? features[a].marker!.index - features[b].marker!.index : features[a].number - features[b].number);
}

/** The mean similarity between a page and a group, for deciding where a left-over page might belong. */
export function meanSimilarity(sim: number[][], page: number, group: number[]): number {
  if (group.length === 0) return -1;
  return group.reduce((sum, i) => sum + sim[page][i], 0) / group.length;
}
