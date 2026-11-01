import { useNodeTools } from '../../native/index.js';
import { useModelProviders } from '../../providers.js';
import { createObjects, useObjects } from '../../objects/index.js';

/**
 * Setup file of the server's test runs: the providers the relay service runs (anthropic, vertex) are known, as they are to the relay, and the
 * tools of the shared code (poppler, Tesseract, sharp ...) are the Node ones, so the tests can run the whole app on Node.
 */
useModelProviders();
useNodeTools();
useObjects(() => createObjects());
