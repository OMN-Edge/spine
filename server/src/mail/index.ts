import { loadMailConfig } from '../config.js';
import { createBrevoMailer } from './adapters/brevo.js';
import { createNoneMailer } from './adapters/none.js';
import { MailerConfigError, type Mailer, type MailerConfig, type MailerFactory } from './types.js';

/** A registry, as for the LLM and store interfaces: a provider is one entry and one file. */
const ADAPTERS = {
  none: createNoneMailer,
  brevo: createBrevoMailer,
} satisfies Record<string, MailerFactory>;

export const MAILERS = Object.keys(ADAPTERS);

/** Pure: validates its config and returns a mailer. Testable with a literal. */
export function createMailer(config: MailerConfig): Mailer {
  const factory = (ADAPTERS as Record<string, MailerFactory | undefined>)[config.adapter];
  if (!factory) {
    throw new MailerConfigError(
      `unknown SPINE_MAILER "${config.adapter}"; expected one of ${MAILERS.join(', ')}`,
    );
  }
  return factory(config);
}

let _mailer: Mailer | null = null;

/** Reads config on first use and memoizes. */
export function getMailer(): Mailer {
  if (!_mailer) _mailer = createMailer(loadMailConfig());
  return _mailer;
}

/** Tests only. */
export function resetMailer(replacement: Mailer | null = null): void {
  _mailer = replacement;
}

export * from './types.js';
