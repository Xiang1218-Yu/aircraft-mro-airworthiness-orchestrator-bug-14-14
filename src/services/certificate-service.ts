import type { CertificateStatus } from '../domain/types.js';
import { Store } from '../store/store.js';

export class CertificateService {
  constructor(private readonly store: Store) {}

  submit(stockId: string, version: number, fingerprint: string): void {
    const stock = this.store.stocks.get(stockId);
    if (!stock) throw new Error('stock not found');
    this.store.certificates.set(stockId, { stockId, tenantId: stock.tenantId, version, status: 'PENDING', fingerprint, updatedAt: this.store.now() });
    stock.certificateVersion = version;
    stock.certificateStatus = 'PENDING';
    stock.version += 1;
  }

  applyProviderResult(stockId: string, version: number, status: CertificateStatus, fingerprint: string): void {
    const stock = this.store.stocks.get(stockId);
    const current = this.store.certificates.get(stockId);
    if (!stock || !current) throw new Error('certificate not found');
    if (version < current.version) {
      this.store.addAudit(stock.tenantId, 'certificate.stale-result', 'certificate', stockId, { version, currentVersion: current.version });
      return;
    }
    if (version === current.version && fingerprint !== current.fingerprint) {
      throw new Error('certificate version fingerprint conflict');
    }
    current.version = version;
    current.status = status;
    current.fingerprint = fingerprint;
    current.updatedAt = this.store.now();
    stock.certificateVersion = version;
    stock.certificateStatus = status;
    stock.version += 1;
    this.store.addAudit(stock.tenantId, 'certificate.updated', 'certificate', stockId, { version, status });
    this.store.addOutbox(stock.tenantId, 'mro.certificate-updated', stockId, { stockId, version, status });
  }
}
