/** The month `n` months before `month` (YYYY-MM), for the counts that are kept for a window of months. */
export const monthsBefore = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1 - n, 1)).toISOString().slice(0, 7);
};
