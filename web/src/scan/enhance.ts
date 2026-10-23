import { newRaster, type Raster } from './image';

/**
 * Making a faded, shadowed or unevenly lit page readable (FR-ING-09) without making anything up: the page's own background is
 * estimated (a heavy blur of a small copy, which pen strokes barely move), every pixel is divided by it so a shadow or a
 * gradient of light is flat white, and the levels are stretched so the page is white and the ink dark. Handwriting and pale print
 * both survive that; a "clean up" that thresholds to black and white would lose them. Everything happens on the device.
 */
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length); const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let sum = 0; const row = y * w;
    for (let x = -radius; x <= radius; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (2 * radius + 1);
      sum += src[row + Math.min(w - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * radius + 1);
      sum += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}

export function enhance(src: Raster): Raster {
  const { width, height } = src;
  const scale = Math.min(1, 200 / Math.max(width, height));
  const w = Math.max(4, Math.round(width * scale)); const h = Math.max(4, Math.round(height * scale));

  // The page's light, per colour channel, from a small copy: the brightest typical value in a neighbourhood is the paper.
  const background: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    const small = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      // Max over the source block, so ink does not darken the estimate.
      const x0 = Math.floor((x * width) / w); const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      const y0 = Math.floor((y * height) / h); const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
      let m = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) m = Math.max(m, src.data[(yy * width + xx) * 4 + c]);
      small[y * w + x] = m;
    }
    background.push(boxBlur(boxBlur(small, w, h, Math.max(2, Math.round(Math.min(w, h) / 10))), w, h, 2));
  }

  const flat = newRaster(width, height);
  const lum = new Uint16Array(256);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(h - 1, (y * h) / height);
    for (let x = 0; x < width; x++) {
      const fx = Math.min(w - 1, (x * w) / width);
      const i = (y * width + x) * 4;
      const bi = Math.floor(fy) * w + Math.floor(fx);
      let l = 0;
      for (let c = 0; c < 3; c++) {
        const v = Math.min(255, (src.data[i + c] * 255) / Math.max(40, background[c][bi]));
        flat.data[i + c] = v; l += v * [0.299, 0.587, 0.114][c];
      }
      flat.data[i + 3] = 255;
      lum[Math.round(l)]++;
    }
  }

  // Levels: the darkest 1% of the page to black-ish ink, and the page itself (already near 255) to white.
  const total = width * height;
  let acc = 0; let low = 0;
  for (let v = 0; v < 256; v++) { acc += lum[v]; if (acc >= total * 0.01) { low = v; break; } }
  const high = 250;
  const range = Math.max(40, high - low);
  for (let i = 0; i < flat.data.length; i += 4) {
    for (let c = 0; c < 3; c++) flat.data[i + c] = Math.min(255, Math.max(0, ((flat.data[i + c] - low) * 255) / range));
  }
  return flat;
}

/**
 * Greyscale with some more contrast, for a page read best as dark print on white: luminance, then pushed away from the middle grey.
 * Meant to follow `enhance` (the paper is already white), so the print gets darker and the paper stays white. It is not a threshold:
 * every grey in between is kept, which is what lets faint print and handwriting survive.
 */
export function greyscale(src: Raster, contrast = 1.35): Raster {
  const out = newRaster(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    const l = 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2];
    const v = Math.min(255, Math.max(0, (l - 128) * contrast + 128));
    out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
  }
  return out;
}

/**
 * Otsu's method (1979): the cut-off that best separates the page's lights from its darks, by maximising the variance between the two
 * groups of a brightness histogram. The usual way to choose one without a number guessed in advance (the `otsu` and `image-filter-js`
 * packages do the same); written from the definition. Kept between `LOW` and `HIGH`, because a page that is nearly all paper has
 * nothing to separate and would otherwise be cut through its noise.
 */
const LOW = 110;
const HIGH = 190;
const FALLBACK = 150;

export function otsuCutoff(brightness: Uint8Array | number[]): number {
  const hist = new Float64Array(256);
  for (const v of brightness) hist[Math.min(255, Math.max(0, Math.round(v)))]++;
  const total = brightness.length;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let weightBack = 0; let sumBack = 0; let best = 0; let cutoff = 127;
  for (let v = 0; v < 256; v++) {
    weightBack += hist[v];
    if (weightBack === 0) continue;
    const weightFront = total - weightBack;
    if (weightFront === 0) break;
    sumBack += v * hist[v];
    const meanBack = sumBack / weightBack; const meanFront = (sumAll - sumBack) / weightFront;
    const between = weightBack * weightFront * (meanBack - meanFront) ** 2;
    if (between > best) { best = between; cutoff = v; }
  }
  // One level only: nothing to separate, so the usual cut-off for a cleaned page.
  return best === 0 ? FALLBACK : Math.min(HIGH, Math.max(LOW, cutoff + 1));
}

/**
 * Pure black and white, for print that is already dark on a pale page (a receipt, a form): every pixel is ink or paper. It follows `enhance`,
 * which has already made the lighting even and the paper white, so one cut-off is enough where the raw photo would need a local one; the
 * cut-off is found with Otsu's method unless one is given. Pale print and handwriting can fall under it and vanish, which is why it is a
 * choice per page and the greyscale and clean versions are the ones to use for those.
 */
export function blackAndWhite(src: Raster, cutoff?: number): Raster {
  const out = newRaster(src.width, src.height);
  const lum = new Uint8Array(src.width * src.height);
  for (let i = 0, j = 0; i < src.data.length; i += 4, j++) lum[j] = 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2];
  const limit = cutoff ?? otsuCutoff(lum);
  for (let i = 0, j = 0; i < src.data.length; i += 4, j++) {
    const v = lum[j] < limit ? 0 : 255;
    out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
  }
  return out;
}
