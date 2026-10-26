import { useAccountsStore } from '../store.js';
import { useModelProviders } from '../providers.js';
import { serveRelay } from './serve.js';

// What this process uses is registered before anything else runs: the model client is built at once, and needs a provider.
useAccountsStore();
useModelProviders();
serveRelay();
