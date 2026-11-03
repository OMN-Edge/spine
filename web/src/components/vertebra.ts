/** Two decimals: enough for any size the app draws at, and a path that a test can compare with `favicon.svg`. */
const n = (v: number) => +v.toFixed(2);

/**
 * The one vertebral body every spine in the app is drawn with (the mark, the favicon, the timeline and upload spines, the public drawings):
 * a rounded block, `w` wide and `h` high from its top-left corner at (`x`, `y`), whose sides curve in at the middle. The corner and the
 * waist are fractions of the height, so a vertebra looks the same at 6 units in the mark as at 26 on the front page.
 */
export function vertebraPath(x: number, y: number, w: number, h: number): string {
  const r = h * 0.19;
  const waist = h * 0.26;
  const [x1, y1, top, bottom] = [x + w, y + h, y + h * 0.3, y + h * 0.7];
  return `M${n(x + r)} ${n(y)}H${n(x1 - r)}Q${n(x1)} ${n(y)} ${n(x1)} ${n(y + r)}`
    + `C${n(x1 - waist)} ${n(top)} ${n(x1 - waist)} ${n(bottom)} ${n(x1)} ${n(y1 - r)}`
    + `Q${n(x1)} ${n(y1)} ${n(x1 - r)} ${n(y1)}H${n(x + r)}Q${n(x)} ${n(y1)} ${n(x)} ${n(y1 - r)}`
    + `C${n(x + waist)} ${n(bottom)} ${n(x + waist)} ${n(top)} ${n(x)} ${n(y + r)}`
    + `Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}Z`;
}
