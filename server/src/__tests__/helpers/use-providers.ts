import { useNodeTools } from '../../native/index.js';
import { useModelProviders } from '../../providers.js';
import { createObjects, useObjects } from '../../objects/index.js';
import { useDemoSource } from 'spine-core/demo/archive.js';
import { clinicDemoSource } from 'spine-core/testing/clinic/source.js';

/**
 * Setup file of the server's test runs: the providers the relay service runs (anthropic, vertex) are known, as they are to the relay, and the
 * tools of the shared code (poppler, Tesseract, sharp ...) are the Node ones, so the tests can run the whole app on Node.
 */
useModelProviders();
useNodeTools();
useObjects(() => createObjects());

// The sample archive comes from the script (a device fetches what its build made); a test that loads it keeps a few documents (`demo.test.ts` gives its own).
useDemoSource(clinicDemoSource({ only: ['thy1-control', 'thy2-consult', 'thy2-lab', 'thy2-control', 'thy2-rx', 'eye-consult', 'eye-glasses'] }));
