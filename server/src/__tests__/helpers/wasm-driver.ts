import { openWasm } from '../../../../web/src/core/sqlite-wasm.js';
import { useDriver } from '../../store/sqlite/index.js';

/** Setup file of `vitest.shim.config.ts`: every store the suite opens runs on the WebAssembly driver. */
useDriver(openWasm);
