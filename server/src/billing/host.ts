import { getAccountsStore } from 'spine-core/store/index.js';
import { logger } from 'spine-core/logger.js';
import { useBillingHost } from 'spine-billing/host.js';
import { alertOperator } from './invoicing/alert.js';

/**
 * What Spine gives `spine-billing` (`packages/billing/`): the store the process keeps, the log, and how the operator is told. Importing this file gives it, once; whatever uses the
 * package imports it, and a process that did not is told what is missing at its first use.
 */
useBillingHost({ store: () => getAccountsStore(), log: logger, alert: alertOperator });
