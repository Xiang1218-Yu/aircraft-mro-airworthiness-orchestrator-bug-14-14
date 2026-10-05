import type { PartRequirement, Reservation, WorkOrder } from '../domain/types.js';
import { Store } from '../store/store.js';

export class InventoryService {
  constructor(private readonly store: Store) {}

  async reserveForWorkOrder(workOrder: WorkOrder): Promise<Reservation[]> {
    return this.store.lock.runExclusive(async () => {
      const candidates: Array<{ stockId: string; quantity: number }> = [];
      for (const requirement of workOrder.requiredParts) {
        const selected = this.selectCandidates(workOrder.tenantId, requirement);
        const available = selected.reduce((sum, item) => sum + item.quantity, 0);
        if (available < requirement.quantity) {
          throw new Error(`insufficient stock for ${requirement.partNumber}`);
        }
        candidates.push(...selected);
      }

      const created: Reservation[] = [];
      for (const candidate of candidates) {
        const stock = this.store.stocks.get(candidate.stockId);
        if (!stock || stock.quantity - stock.reserved < candidate.quantity) {
          throw new Error('stock changed while reserving');
        }
        stock.reserved += candidate.quantity;
        stock.version += 1;
        const reservation: Reservation = {
          id: this.store.nextId('reservation'),
          tenantId: workOrder.tenantId,
          workOrderId: workOrder.id,
          stockId: stock.id,
          quantity: candidate.quantity,
          status: 'ACTIVE',
          createdAt: this.store.now(),
          version: 1,
        };
        this.store.reservations.set(reservation.id, reservation);
        workOrder.reservations.push(reservation.id);
        created.push(reservation);
        this.store.addAudit(workOrder.tenantId, 'inventory.reserved', 'reservation', reservation.id, { stockId: stock.id, quantity: candidate.quantity });
      }
      workOrder.status = 'MATERIALS_RESERVED';
      workOrder.version += 1;
      this.store.addOutbox(workOrder.tenantId, 'mro.materials-reserved', workOrder.id, { workOrderId: workOrder.id, reservationIds: created.map((item) => item.id) });
      return created;
    });
  }

  async releaseForWorkOrder(workOrderId: string, reason: string): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const workOrder = this.store.workOrders.get(workOrderId);
      if (!workOrder) throw new Error('work order not found');
      for (const reservationId of workOrder.reservations) {
        const reservation = this.store.reservations.get(reservationId);
        if (!reservation || reservation.status !== 'ACTIVE') continue;
        const stock = this.store.stocks.get(reservation.stockId);
        if (!stock) continue;
        stock.reserved = Math.max(0, stock.reserved - reservation.quantity);
        stock.version += 1;
        reservation.status = 'RELEASED';
        reservation.version += 1;
        this.store.addAudit(workOrder.tenantId, 'inventory.released', 'reservation', reservation.id, { reason, quantity: reservation.quantity });
      }
      this.store.addOutbox(workOrder.tenantId, 'mro.materials-released', workOrder.id, { workOrderId, reason });
    });
  }

  async confirmIssue(reservationId: string): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const reservation = this.store.reservations.get(reservationId);
      if (!reservation || reservation.status !== 'ACTIVE') throw new Error('reservation is not active');
      const stock = this.store.stocks.get(reservation.stockId);
      if (!stock || stock.qualityStatus !== 'RELEASED') throw new Error('stock is not releasable');
      if (stock.quantity - stock.reserved < 0) throw new Error('stock is unavailable');
      stock.quantity -= reservation.quantity;
      stock.reserved -= reservation.quantity;
      stock.version += 1;
      reservation.status = 'ISSUED';
      reservation.version += 1;
      this.store.addAudit(reservation.tenantId, 'inventory.issued', 'reservation', reservation.id, { stockId: stock.id, quantity: reservation.quantity });
      this.store.addOutbox(reservation.tenantId, 'mro.stock-issued', reservation.workOrderId, { reservationId, stockId: stock.id });
    });
  }

  recall(stockId: string): void {
    const stock = this.store.stocks.get(stockId);
    if (!stock) throw new Error('stock not found');
    stock.qualityStatus = 'RECALLED';
    stock.version += 1;
    this.store.addAudit(stock.tenantId, 'inventory.recalled', 'stock', stock.id);
    this.store.addOutbox(stock.tenantId, 'mro.stock-recalled', stock.id, { stockId });
  }

  private selectCandidates(tenantId: string, requirement: PartRequirement): Array<{ stockId: string; quantity: number }> {
    let remaining = requirement.quantity;
    const stocks = [...this.store.stocks.values()]
      .filter((stock) => stock.tenantId === tenantId && stock.partNumber === requirement.partNumber)
      .filter((stock) => stock.qualityStatus === 'RELEASED' && stock.certificateStatus === 'APPROVED')
      .filter((stock) => new Date(stock.certificateExpiresOn).getTime() >= Date.now())
      .sort((left, right) => left.certificateExpiresOn.localeCompare(right.certificateExpiresOn));
    const selected: Array<{ stockId: string; quantity: number }> = [];
    for (const stock of stocks) {
      if (remaining <= 0) break;
      if (stock.kind === 'SERIALIZED' && requirement.serialNumbers && !requirement.serialNumbers.includes(stock.serialNumber ?? '')) continue;
      const quantity = Math.min(remaining, stock.quantity - stock.reserved);
      if (quantity <= 0) continue;
      selected.push({ stockId: stock.id, quantity });
      remaining -= quantity;
    }
    return selected;
  }
}
