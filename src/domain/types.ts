export type TenantId = string;
export type StockKind = 'SERIALIZED' | 'LOT';
export type QualityStatus = 'RELEASED' | 'QUARANTINED' | 'RECALLED' | 'FROZEN';
export type WorkOrderStatus = 'OPEN' | 'MATERIALS_RESERVED' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'CLOSED' | 'CANCELLED';
export type ReservationStatus = 'ACTIVE' | 'RELEASED' | 'ISSUED';
export type CertificateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
export type CustomsStatus = 'DRAFT' | 'SUBMITTED' | 'INSPECTION' | 'RELEASED' | 'REJECTED';
export type ReturnStatus = 'EXPECTED' | 'RECEIVED' | 'ACCEPTED' | 'REJECTED' | 'SCRAPPED';

export interface PartStock {
  id: string;
  tenantId: TenantId;
  partNumber: string;
  kind: StockKind;
  serialNumber?: string;
  lotNumber: string;
  quantity: number;
  reserved: number;
  qualityStatus: QualityStatus;
  certificateVersion: number;
  certificateStatus: CertificateStatus;
  certificateExpiresOn: string;
  certificateTimeZone: string;
  location: string;
  version: number;
}

export interface PartRequirement {
  partNumber: string;
  quantity: number;
  serialNumbers?: string[];
}

export interface Reservation {
  id: string;
  tenantId: TenantId;
  workOrderId: string;
  stockId: string;
  quantity: number;
  status: ReservationStatus;
  createdAt: string;
  version: number;
}

export interface WorkOrderEvent {
  id: string;
  source: string;
  sequence: number;
  type: 'STARTED' | 'PAUSED' | 'COMPLETED' | 'CLOSED' | 'CANCELLED';
  occurredAt: string;
}

export interface InstalledPart {
  receiptId: string;
  stockId: string;
  workOrderId: string;
  aircraftId: string;
  position: string;
  installedAt: string;
}

export interface WorkOrder {
  id: string;
  tenantId: TenantId;
  aircraftId: string;
  status: WorkOrderStatus;
  requiredParts: PartRequirement[];
  reservations: string[];
  installedParts: InstalledPart[];
  lastEventSequence: Record<string, number>;
  processedEventIds: string[];
  version: number;
}

export interface CertificateRecord {
  stockId: string;
  tenantId: TenantId;
  version: number;
  status: CertificateStatus;
  fingerprint: string;
  updatedAt: string;
}

export interface CustomsDeclaration {
  id: string;
  tenantId: TenantId;
  shipmentId: string;
  version: number;
  status: CustomsStatus;
  updatedAt: string;
}

export interface CustomsCallback {
  declarationId: string;
  version: number;
  status: CustomsStatus;
  callbackId: string;
  receivedAt: string;
}

export interface ExternalEvent {
  tenantId: TenantId;
  source: string;
  type: string;
  entityId: string;
  externalId: string;
  payloadHash: string;
}

export interface CoreReturn {
  id: string;
  tenantId: TenantId;
  workOrderId: string;
  stockId: string;
  status: ReturnStatus;
  settlementAmount: number;
  receivedAt?: string;
}

export interface OutboxMessage {
  id: string;
  tenantId: TenantId;
  topic: string;
  aggregateId: string;
  payload: string;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  createdAt: string;
}

export interface AuditRecord {
  id: string;
  tenantId: TenantId;
  action: string;
  entity: string;
  entityId: string;
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  tenantId: TenantId;
  account: string;
  referenceId: string;
  amount: number;
  direction: 'DEBIT' | 'CREDIT';
  createdAt: string;
}

export interface DependentTask {
  id: string;
  workOrderId: string;
  dependsOn: string[];
  status: 'BLOCKED' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  version: number;
}
