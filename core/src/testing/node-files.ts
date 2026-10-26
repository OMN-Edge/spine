import fs from 'node:fs';
import { useFiles, type Files } from '../files.js';

/** The files of the tests and of the real-model suite: Node's disk. The device brings memory (`web/src/core/shims/fs.ts`). */
export const nodeFiles: Files = {
  existsSync: p => fs.existsSync(p),
  statSync: p => fs.statSync(p),
  readFileSync: p => fs.readFileSync(p),
  readTextSync: p => fs.readFileSync(p, 'utf8'),
  readFile: p => fs.promises.readFile(p),
  readHead(p, length) {
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(p, 'r');
    try { return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, 0)); } finally { fs.closeSync(fd); }
  },
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  mkdirSync: p => void fs.mkdirSync(p, { recursive: true }),
  rmSync: p => fs.rmSync(p, { recursive: true, force: true }),
  renameSync: (from, to) => fs.renameSync(from, to),
  copyFileSync: (from, to) => fs.copyFileSync(from, to),
  readStream: p => fs.createReadStream(p),
  writeStream(p) {
    const out = fs.createWriteStream(p);
    let failure: Error | null = null;
    out.on('error', err => { failure = err; });
    return {
      write: chunk => new Promise<void>((resolve, reject) => {
        if (failure) return reject(failure);
        if (out.write(chunk)) resolve(); else out.once('drain', resolve);
      }),
      end: () => new Promise<void>((resolve, reject) => {
        if (failure) return reject(failure);
        out.end(() => (failure ? reject(failure) : resolve()));
      }),
    };
  },
};

export const useNodeFiles = (): void => useFiles(nodeFiles);
