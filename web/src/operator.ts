import { useEffect, useState } from 'react';
import { api, type Operator } from './api';

let pending: Promise<Operator | null> | null = null;

/** Who runs this instance, asked of the server once for all the pages that show it, and null until it answers (or where nothing is set). */
export function useOperator(): Operator | null {
  const [operator, setOperator] = useState<Operator | null>(null);
  useEffect(() => {
    let live = true;
    pending ??= api.auth.options().then(o => o.operator ?? null).catch(() => { pending = null; return null; });
    void pending.then(o => { if (live) setOperator(o); });
    return () => { live = false; };
  }, []);
  return operator;
}

/** The parts of the company line, in order: the intro with the name, the numbers, the address, the contact. Each is shown as the operator wrote it. */
export function companyParts(operator: Operator, intro: string): string[] {
  return [intro, ...operator.ids, ...(operator.address ? [operator.address] : []), ...(operator.contact ? [operator.contact] : [])];
}
