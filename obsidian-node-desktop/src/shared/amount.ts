/** "20000.000000000000000000" → "20,000.00": trims trailing zeros (keeping two decimals) and groups thousands. Display only. */
export function prettyObs(value: string | null | undefined): string {
  if (value === null || value === undefined || !/^-?\d+(\.\d+)?$/.test(value)) return '—';
  const [intPart = '0', frac = ''] = value.split('.');
  const neg = intPart.startsWith('-');
  const body = neg ? intPart.slice(1) : intPart;
  return `${neg ? '-' : ''}${body.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac.replace(/0+$/, '').padEnd(2, '0')}`;
}
