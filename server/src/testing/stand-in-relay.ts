import { useAccountsStore } from '../store.js';
import { serveRelay } from '../relay/serve.js';
import { useStandInProviders } from './stand-in.js';

// The relay's entry point (relay/main.ts) with the stand-in model in place of a vendor; `npm run check:app` runs this. Not in any build.
useAccountsStore();
useStandInProviders();
serveRelay();
