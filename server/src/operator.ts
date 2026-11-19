import { getAccountsStore } from 'spine-core/store/index.js';
import { loadBillingConfig } from './billing/config.js';
import { sellerOf } from './billing/invoicing/seller.js';
import { operatorInfo, type OperatorInfo } from './legal.js';

/** Who runs this instance, for the footer, the terms and the pricing page: the saved seller where billing is on, and nobody where it is off (a self-hosted instance names no company). */
export async function currentOperator(env: NodeJS.ProcessEnv = process.env): Promise<OperatorInfo | null> {
  if (!loadBillingConfig(env).enabled) return null;
  return operatorInfo(await sellerOf(getAccountsStore()), env);
}
