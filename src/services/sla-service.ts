import { Store } from '../store/store.js';

function localDateOf(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export class SlaService {
  constructor(private readonly store: Store) {}

  isCertificateUsableAt(stockId: string, asOf: string): boolean {
    const stock = this.store.stocks.get(stockId);
    if (!stock) throw new Error('stock not found');
    const localDate = localDateOf(asOf, stock.certificateTimeZone);
    return localDate <= stock.certificateExpiresOn;
  }
}
