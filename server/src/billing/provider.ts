import { publicUrl } from 'spine-core/config.js';
import { billingDetailsSchema } from 'spine-core/billing/billing-details.js';
import { billingProvider as providerFor, type BillingProvider, type Presentation } from 'spine-billing/provider.js';
import { recipientLanguage, tm } from '../mail/i18n.js';
import type { BillingConfig } from './config.js';
import './host.js';

/**
 * The payment provider as Spine uses it: the adapters, the events and the interface are `spine-billing` (`packages/billing/`); what is Spine's is given to them here: where the buyer comes
 * back to, the words next to the box the buyer ticks and the language of the provider's page, and what makes a customer's billing details complete (Romania's counties, a sector in Bucharest).
 */
export * from 'spine-billing/provider.js';
export type Enabled = Extract<BillingConfig, { enabled: true }>;

/** The words next to the box the buyer ticks before paying: the service starts now, and the right of withdrawal ends once it is fully provided. */
export function withdrawalConsent(lang: ReturnType<typeof recipientLanguage>): string {
  return tm(lang, 'I ask for the service to start now. I understand that I lose my right of withdrawal once it has been fully provided, and that if I withdraw after using it I pay for what I used. I have read the [terms]({terms}) and the [refund policy]({refunds}).', { terms: publicUrl('/terms'), refunds: publicUrl('/refunds') });
}


const presentation: Presentation = {
  returnUrl: () => publicUrl('/account'),
  checkoutWords: language => {
    const lang = recipientLanguage({ email: '', language });
    return { consent: withdrawalConsent(lang), locale: lang !== 'en' || language === 'en' ? lang : null };
  },
  parseDetails: raw => {
    const parsed = billingDetailsSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
};

/** The active provider, from the settings. */
export function billingProvider(config: Enabled): BillingProvider { return providerFor(config, presentation); }
