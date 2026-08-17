import type { EventEnvelope } from "@noryx/shared-types";

export type EventHandler<T = unknown> = (
  event: EventEnvelope<T>,
) => Promise<void>;

/**
 * Every service depends on this interface, never on a concrete broker.
 * Idempotent-consumer and dead-letter-queue behavior (System Architecture
 * v1 §4.1) are the adapter's responsibility, not the caller's.
 */
export interface EventBus {
  publish<T>(event: EventEnvelope<T>): Promise<void>;
  subscribe<T>(eventType: string, handler: EventHandler<T>): Promise<void>;
  close(): Promise<void>;
}

export function makeEventId(): string {
  return crypto.randomUUID();
}
