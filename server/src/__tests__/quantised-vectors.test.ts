import { describe, it, expect } from 'vitest';
import { quantise, dequantise } from '../similarity/index.js';

/** TR-AI-14: vectors are kept as signed bytes with a scale, a quarter of the size, and rank documents as the whole ones do. */
const DIMS = 768;
let seed = 7;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
const unit = (): Float32Array => {
  const v = Float32Array.from({ length: DIMS }, random);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm) as Float32Array;
};
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe('quantised vectors', () => {
  it('take a quarter of the space and read back close to the original', () => {
    const v = unit();
    const stored = quantise(v);
    expect(stored.length).toBe(DIMS + 4);
    const back = dequantise(stored, DIMS)!;
    expect(dot(v, back)).toBeGreaterThan(0.999);
  });

  it('keep the order a search gives: the same top results as the whole vectors', () => {
    const query = unit();
    const docs = Array.from({ length: 200 }, unit);
    // Make a few documents truly close to the query, so there is an order worth keeping.
    for (let i = 0; i < 10; i++) docs[i] = docs[i].map((x, j) => x * (0.3 + i * 0.05) + query[j] * (1 - i * 0.08)) as Float32Array;
    const rank = (vectors: Float32Array[]) => vectors.map((v, i) => [i, dot(query, v)] as const).sort((a, b) => b[1] - a[1]).slice(0, 10).map(r => r[0]);
    const whole = rank(docs);
    const quantised = rank(docs.map(v => dequantise(quantise(v), DIMS)!));
    expect(quantised).toEqual(whole);
  });

  it('still reads a vector stored whole before this, and refuses a length that is neither', () => {
    const v = unit();
    const legacy = Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    expect(Array.from(dequantise(legacy, DIMS)!)).toEqual(Array.from(v));
    expect(dequantise(Buffer.alloc(10), DIMS)).toBeNull();
  });

  it('handles a zero vector without dividing by zero', () => {
    expect(Array.from(dequantise(quantise(new Float32Array(8)), 8)!).every(x => x === 0)).toBe(true);
  });
});
