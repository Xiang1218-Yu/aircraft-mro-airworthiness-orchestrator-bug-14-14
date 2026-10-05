import type { CoreReturn, ReturnStatus } from '../domain/types.js';
import { Store } from '../store/store.js';

export class SettlementService {
  constructor(private readonly store: Store) {}

  receiveCore(coreReturnId: string, receivedAt: string): void {
    const core = this.store.coreReturns.get(coreReturnId);
    if (!core) throw new Error('core return not found');
    if (core.status === 'RECEIVED' || core.status === 'ACCEPTED' || core.status === 'REJECTED' || core.status === 'SCRAPPED') return;
    core.status = 'RECEIVED';
    core.receivedAt = receivedAt;
    core.status = this.evaluate(core);
    if (core.status === 'ACCEPTED') {
      this.store.addLedger({ tenantId: core.tenantId, account: 'warranty-core-credit', referenceId: core.id, amount: core.settlementAmount, direction: 'CREDIT' });
    }
    this.store.addAudit(core.tenantId, 'core-return.settled', 'core-return', core.id, { status: core.status, amount: core.settlementAmount });
    this.store.addOutbox(core.tenantId, 'mro.core-return-settled', core.workOrderId, { coreReturnId: core.id, status: core.status });
  }

  updateInspection(coreReturnId: string, status: ReturnStatus): void {
    const core = this.store.coreReturns.get(coreReturnId);
    if (!core) throw new Error('core return not found');
    if (core.status === 'ACCEPTED' || core.status === 'REJECTED' || core.status === 'SCRAPPED') return;
    core.status = status;
  }

  private evaluate(core: CoreReturn): ReturnStatus {
    return core.status === 'RECEIVED' ? 'ACCEPTED' : core.status;
  }
}
