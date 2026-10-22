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
