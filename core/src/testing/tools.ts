import { execFileSync } from 'node:child_process';

const works = (command: string) => { try { execFileSync(command, ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } };

/**
 * A skipped test is reported as a green one. Where the tools are expected (CI sets `CI`), a missing tool is a failure, not a skip: on a
 * runner without them a whole group of tests (export, import, photos, sample records) would stop running and nobody would see it.
 */
export function requireWhereExpected(found: boolean, env: NodeJS.ProcessEnv): boolean {
  if (!found && env.CI) {
    throw new Error('poppler-utils is not installed, so the PDF tests would be skipped and still look green (apt-get install poppler-utils; brew install poppler)');
  }
  return found;
}

/** Poppler's command line tools, which the tests of PDFs, photos, export and the sample records run for real. */
export const hasPoppler = requireWhereExpected(['pdftoppm', 'pdfinfo', 'pdfimages', 'pdfseparate', 'pdfunite', 'pdftotext'].every(works), process.env);
