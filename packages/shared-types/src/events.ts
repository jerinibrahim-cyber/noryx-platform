/**
 * Versioned event envelope for the internal async backbone (System
 * Architecture v1 §4.1). Every event Sphere/Orbis/shared services publish
 * or consume is wrapped in this shape — consumers must be idempotent on
 * `id`, and a breaking payload change bumps `version` rather than mutating
 * an existing contract in place.
 */
export interface EventEnvelope<TPayload = unknown> {
  /** Unique event id — the idempotency key for consumers. */
  id: string;
  /** Dot-namespaced event name, e.g. "orbis.workorder.completed". */
  type: string;
  /** Contract version for this event `type`, independent of other events. */
  version: number;
  tenantId: string;
  legalEntityId?: string;
  /** ISO-8601 timestamp the event was published. */
  occurredAt: string;
  /** The service that published this event, e.g. "orbis-helpdesk-wo". */
  source: string;
  payload: TPayload;
  /** Set when this event is a retry/redelivery from a dead-letter queue. */
  redeliveryCount?: number;
}

// --- Example Phase-1 event contracts (illustrative — each owning service
// should extend this file or publish its own when the module ships) -------

export interface WorkOrderCompletedPayload {
  workOrderId: string;
  contractId: string;
  chargeable: boolean;
  laborHours: number;
  materialCost: number;
  completedAt: string;
}
export type WorkOrderCompletedEvent = EventEnvelope<WorkOrderCompletedPayload>;

export interface OpportunityWonPayload {
  opportunityId: string;
  partyId: string;
  contractValueMinor: number; // minor currency units (fils/cents)
  currencyCode: string;
}
export type OpportunityWonEvent = EventEnvelope<OpportunityWonPayload>;

export interface TenantProvisionedPayload {
  tenantId: string;
  slug: string;
  defaultLegalEntityId: string;
  plan: string;
}
export type TenantProvisionedEvent = EventEnvelope<TenantProvisionedPayload>;
