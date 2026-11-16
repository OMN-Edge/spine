/**
 * What to suggest paying back when a buyer withdraws within the fourteen days (Directive 2011/83/EU, Article 14(3), and the refund policy in `docs/legal/refunds.md`): the
 * buyer pays an amount in proportion to what has been provided until they told us, compared with the whole of the contract, worked out on the price paid. A plan is
 * provided over its period, so the share is the days that have run (a day begun counts) of the days the period has; an account that used none of the service since its first
 * payment is suggested the whole of it, since nothing it could have wanted was used. It is a suggestion: the operator decides each request and may pay back another amount.
 */
export interface SuggestedRefund {
  /** What to pay back and what is kept, in the minor unit. */
  refundMinor: number;
  keptMinor: number;
  currency: string;
  /** `unused` when nothing was used, `time` when the days that have run are the measure. */
  basis: 'unused' | 'time';
  days: number;
  periodDays: number;
}

const DAY = 86_400_000;
const PERIOD_DAYS = { month: 30, year: 365 } as const;

export function suggestedRefund(input: {
  paidMinor: number; currency: string; interval: 'month' | 'year'; paidAt: Date; asked: Date;
  used: { pages: number; questions: number; translated: number } | null;
}): SuggestedRefund {
  const periodDays = PERIOD_DAYS[input.interval];
  const days = Math.min(periodDays, Math.max(1, Math.ceil((input.asked.getTime() - input.paidAt.getTime()) / DAY)));
  const unused = !!input.used && input.used.pages + input.used.questions + input.used.translated === 0;
  const keptMinor = unused ? 0 : Math.min(input.paidMinor, Math.round(input.paidMinor * days / periodDays));
  return { refundMinor: input.paidMinor - keptMinor, keptMinor, currency: input.currency, basis: unused ? 'unused' : 'time', days, periodDays };
}
