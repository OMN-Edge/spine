import { describeStoreContract } from '../../testing/store-contract.js';
import { createSqliteStoreWith } from '../../store/sqlite/store.js';
import { openNative } from '../../store/sqlite/driver-native.js';

describeStoreContract('sqlite', () => createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, openNative));
