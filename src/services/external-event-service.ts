import type { ExternalEvent } from '../domain/types.js';
import { Store } from '../store/store.js';

export class ExternalEventService {
  constructor(private readonly store: Store) {}

  process(event: ExternalEvent, apply: () => void): 'APPLIED' | 'DUPLICATE' {
    const key = [event.tenantId, event.source, event.type, event.entityId, event.externalId].join('|');
    const existing = this.store.externalEvents.get(key);
    if (existing) {
      if (existing.payloadHash !== event.payloadHash) throw new Error('external event fingerprint conflict');
      return 'DUPLICATE';
    }
    this.store.externalEvents.set(key, event);
    apply();
    return 'APPLIED';
  }
}
