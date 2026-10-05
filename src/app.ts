import type { CoreReturn, PartStock, WorkOrder } from './domain/types.js';
import { CertificateService } from './services/certificate-service.js';
import { CustomsService } from './services/customs-service.js';
import { ExternalEventService } from './services/external-event-service.js';
import { InstallationService } from './services/installation-service.js';
import { InventoryService } from './services/inventory-service.js';
import { SettlementService } from './services/settlement-service.js';
import { SlaService } from './services/sla-service.js';
import { TenantJobService } from './services/tenant-job-service.js';
import { WorkOrderService } from './services/work-order-service.js';
import { Store } from './store/store.js';

export class MroApplication {
  readonly store = new Store();
  readonly inventory = new InventoryService(this.store);
  readonly certificates = new CertificateService(this.store);
  readonly workOrders = new WorkOrderService(this.store);
  readonly customs = new CustomsService(this.store);
  readonly tenantJobs = new TenantJobService(this.store);
  readonly settlement = new SettlementService(this.store);
  readonly installation = new InstallationService(this.store);
  readonly externalEvents = new ExternalEventService(this.store);
  readonly sla = new SlaService(this.store);

  seed(): void {
    const stock: PartStock = {
      id: 'stock_demo_001', tenantId: 'tenant_demo', partNumber: 'PUMP-9000', kind: 'SERIALIZED', serialNumber: 'SN-9000-01', lotNumber: 'LOT-2026-09', quantity: 1, reserved: 0,
      qualityStatus: 'RELEASED', certificateVersion: 1, certificateStatus: 'APPROVED', certificateExpiresOn: '2027-12-31', certificateTimeZone: 'Asia/Shanghai', location: 'SHA-A1', version: 1,
    };
    this.store.stocks.set(stock.id, stock);
    this.store.certificates.set(stock.id, { stockId: stock.id, tenantId: stock.tenantId, version: 1, status: 'APPROVED', fingerprint: 'demo', updatedAt: this.store.now() });
    const workOrder: WorkOrder = { id: 'wo_demo_001', tenantId: 'tenant_demo', aircraftId: 'aircraft_demo_001', status: 'OPEN', requiredParts: [{ partNumber: 'PUMP-9000', quantity: 1, serialNumbers: ['SN-9000-01'] }], reservations: [], installedParts: [], lastEventSequence: {}, processedEventIds: [], version: 1 };
    this.store.workOrders.set(workOrder.id, workOrder);
    const core: CoreReturn = { id: 'core_demo_001', tenantId: 'tenant_demo', workOrderId: workOrder.id, stockId: stock.id, status: 'EXPECTED', settlementAmount: 1000 };
    this.store.coreReturns.set(core.id, core);
  }

  async demo(): Promise<void> {
    this.seed();
    const workOrder = this.store.workOrders.get('wo_demo_001');
    if (!workOrder) throw new Error('demo work order missing');
    await this.inventory.reserveForWorkOrder(workOrder);
    console.log(JSON.stringify({ workOrder: workOrder.id, reservations: workOrder.reservations, outbox: this.store.outbox.length }, null, 2));
  }
}
