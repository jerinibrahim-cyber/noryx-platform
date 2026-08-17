import type { EventEnvelope } from "@noryx/shared-types";
import type { EventBus, EventHandler } from "./event-bus";

const MAX_ATTEMPTS = 3;

/**
 * In-process event bus for local dev and unit/integration tests — same
 * interface as the Azure Service Bus adapter, so tests never need a real
 * broker. Retries a failing handler up to MAX_ATTEMPTS before routing the
 * event to an in-memory dead-letter list (inspectable via `deadLetters`),
 * mirroring the DLQ behavior every production adapter must provide.
 */
export class InMemoryEventBus implements EventBus {
  // Heterogeneous map: each key's handlers are actually EventHandler<T> for
  // that key's own T, but a single Map can't express that — publish/subscribe
  // above are what keep this type-safe from the outside.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<string, EventHandler<any>[]>();
  public readonly deadLetters: EventEnvelope[] = [];

  async publish<T>(event: EventEnvelope<T>): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      await this.deliverWithRetry(event, handler);
    }
  }

  async subscribe<T>(
    eventType: string,
    handler: EventHandler<T>,
  ): Promise<void> {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }

  private async deliverWithRetry<T>(
    event: EventEnvelope<T>,
    handler: EventHandler<T>,
  ): Promise<void> {
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      try {
        await handler(event);
        return;
      } catch {
        if (attempt >= MAX_ATTEMPTS) {
          this.deadLetters.push({ ...event, redeliveryCount: attempt });
          return;
        }
      }
    }
  }
}
