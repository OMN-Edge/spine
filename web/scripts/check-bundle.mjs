// Run at the end of `npm run build`: the core's worker must be one file.
//
// The server's code, running in the worker, reads `process` and `Buffer` as globals that src/core/shims/globals.ts sets, and the Node
// polyfills (stream, util) read them as soon as they are evaluated. A bundler that splits the worker into chunks runs the shared ones first,
// before the shim, and the core never starts. A newer Rollup did exactly that, and nothing but the browser check noticed. So the build says it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What is wrong with the built assets in `dir`: empty when the worker is one file that imports nothing beside itself. */
export function bundleProblems(dir) {
  const problems = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const workers = files.filter(f => /^core\.worker-.*\.js$/.test(f));
  if (workers.length !== 1) problems.push(`expected one core.worker-*.js in ${dir}, found ${workers.length}`);
  for (const worker of workers) {
    const text = fs.readFileSync(path.join(dir, worker), 'utf8');
    if (/\bfrom\s*["']\.\/[^"']+["']/.test(text) || /\bimport\s*\(\s*["']\.\/[^"']+["']/.test(text) || /^import\s*["']\.\/[^"']+["']/m.test(text)) {
      problems.push(`${worker} imports another chunk: the worker must be one file (worker.rollupOptions.output.inlineDynamicImports in vite.config.ts)`);
    }
  }
  const split = files.filter(f => /^_commonjs-dynamic-modules-.*\.js$/.test(f));
  if (split.length > 0) problems.push(`the bundle was split (${split.join(', ')}): the Node polyfills would run before the globals shim`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = bundleProblems(path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/assets'));
  if (problems.length > 0) {
    console.error(`FAIL the built core is not safe to run:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('bundle ok: the core worker is one file');
}
