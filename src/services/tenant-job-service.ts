import { Store } from '../store/store.js';

export class TenantJobService {
  constructor(private readonly store: Store) {}

  scanExpiredCertificates(tenantId: string, asOf: string): string[] {
    const expired: string[] = [];
    for (const stock of this.store.stocks.values()) {
      if (stock.tenantId !== tenantId) continue;
      if (stock.certificateExpiresOn <= asOf && stock.qualityStatus === 'RELEASED') {
        stock.qualityStatus = 'FROZEN';
        stock.version += 1;
        expired.push(stock.id);
        this.store.addAudit(tenantId, 'certificate.expired', 'stock', stock.id, { asOf });
        this.store.addOutbox(tenantId, 'mro.certificate-expired', stock.id, { stockId: stock.id, asOf });
      }
    }
    return expired;
  }
}
