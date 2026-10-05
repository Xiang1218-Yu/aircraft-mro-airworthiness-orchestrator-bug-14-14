import type { InstalledPart } from '../domain/types.js';
import { Store } from '../store/store.js';

export class InstallationService {
  constructor(private readonly store: Store) {}

  applyReceipt(part: InstalledPart): void {
    const workOrder = this.store.workOrders.get(part.workOrderId);
    const stock = this.store.stocks.get(part.stockId);
    if (!workOrder || !stock) throw new Error('installation aggregate not found');
    if (this.store.installedParts.has(part.receiptId)) return;
    const existing = [...this.store.installedParts.values()].find((item) => item.stockId === part.stockId);
    if (existing) throw new Error('serialized part already installed');
    this.store.installedParts.set(part.receiptId, part);
    workOrder.installedParts.push(part);
    workOrder.version += 1;
    this.store.addAudit(workOrder.tenantId, 'part.installed', 'work-order', workOrder.id, { stockId: stock.id, position: part.position });
    this.store.addOutbox(workOrder.tenantId, 'mro.part-installed', workOrder.id, { receiptId: part.receiptId, stockId: part.stockId });
  }
}
