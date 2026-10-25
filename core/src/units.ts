/**
 * Whether two unit strings mean the same unit. Clinics print one unit many ways: "mUI/mL" and
 * "mIU/mL" (Romanian UI, English IU), "µg/dL" and "ug/dL", "uU/ml" and "µIU/mL". The key is for
 * comparing only; what is shown stays as printed.
 */
export function unitKey(unit: string | null | undefined): string | null {
  const text = (unit ?? '')
    .toLowerCase()
    .replace(/[µμ]/g, 'u')
    .replace(/\s+/g, '');
  if (!text) return null;
  return text
    .replace(/(^|\/)(m|u|n)?ui(?=\/|$)/g, '$1$2iu') // UI (Romanian) is IU
    .replace(/^(m|u)u(?=\/)/, '$1iu'); // "uU/ml" is micro-international units
}
