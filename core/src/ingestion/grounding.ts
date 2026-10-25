import type { UnstructuredElement } from '../types.js';

interface GroundedField {
  page_id: string;
  bbox_x0: number | null;
  bbox_y0: number | null;
  bbox_x1: number | null;
  bbox_y1: number | null;
}

/**
 * Match a source_snippet to an element's bbox on its page.
 * Returns fractional coords (0-1) or nulls if no confident match found.
 */
export function groundSnippet(
  sourceSnippet: string,
  pageElements: UnstructuredElement[],
  imageWidth: number,
  imageHeight: number,
): { bbox_x0: number | null; bbox_y0: number | null; bbox_x1: number | null; bbox_y1: number | null } {
  if (!sourceSnippet || !pageElements.length) {
    return { bbox_x0: null, bbox_y0: null, bbox_x1: null, bbox_y1: null };
  }

  const needle = sourceSnippet.toLowerCase().trim();

  // 1. Exact containment
  let match = pageElements.find(el => el.text.toLowerCase().includes(needle));

  // 2. Partial match — find the element that shares the longest common substring
  if (!match) {
    let bestScore = 0;
    for (const el of pageElements) {
      const score = longestCommonSubstring(needle, el.text.toLowerCase());
      if (score > bestScore && score > needle.length * 0.6) {
        bestScore = score;
        match = el;
      }
    }
  }

  if (!match?.bbox) {
    return { bbox_x0: null, bbox_y0: null, bbox_x1: null, bbox_y1: null };
  }

  const { x0, y0, x1, y1 } = match.bbox;
  return {
    bbox_x0: x0 / imageWidth,
    bbox_y0: y0 / imageHeight,
    bbox_x1: x1 / imageWidth,
    bbox_y1: y1 / imageHeight,
  };
}

function longestCommonSubstring(a: string, b: string): number {
  let max = 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > max) max = dp[i][j];
      }
    }
  }
  return max;
}
