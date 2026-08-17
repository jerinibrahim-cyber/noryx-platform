import { InMemoryEventBus } from "./in-memory-event-bus";
import { makeEventId } from "./event-bus";
import type { EventEnvelope } from "@noryx/shared-types";

function testEvent(type: string, payload: unknown = {}): EventEnvelope {
  return {
    id: makeEventId(),
    type,
    version: 1,
    tenantId: "tenant-1",
    occurredAt: new Date().toISOString(),
    source: "test",
    payload,
  };
}

describe("InMemoryEventBus", () => {
  it("delivers a published event to a subscribed handler", async () => {
    const bus = new InMemoryEventBus();
    const received: EventEnvelope[] = [];
    await bus.subscribe("test.event", async (e) => {
      received.push(e);
    });

    const event = testEvent("test.event", { hello: "world" });
    await bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(event.id);
  });

  it("does not deliver events of a different type", async () => {
    const bus = new InMemoryEventBus();
    const received: EventEnvelope[] = [];
    await bus.subscribe("test.a", async (e) => {
      received.push(e);
    });

    await bus.publish(testEvent("test.b"));
    expect(received).toHaveLength(0);
  });

  it("supports multiple subscribers to the same event type", async () => {
    const bus = new InMemoryEventBus();
    let countA = 0;
    let countB = 0;
    await bus.subscribe("test.event", async () => {
      countA += 1;
    });
    await bus.subscribe("test.event", async () => {
      countB += 1;
    });

    await bus.publish(testEvent("test.event"));
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  it("retries a failing handler and eventually dead-letters the event", async () => {
    const bus = new InMemoryEventBus();
    let attempts = 0;
    await bus.subscribe("test.failing", async () => {
      attempts += 1;
      throw new Error("simulated downstream failure");
    });

    const event = testEvent("test.failing");
    await bus.publish(event);

    expect(attempts).toBe(3); // MAX_ATTEMPTS
    expect(bus.deadLetters).toHaveLength(1);
    expect(bus.deadLetters[0]?.id).toBe(event.id);
  });

  it("does not dead-letter an event that succeeds after a retry", async () => {
    const bus = new InMemoryEventBus();
    let attempts = 0;
    await bus.subscribe("test.flaky", async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("transient failure");
    });

    await bus.publish(testEvent("test.flaky"));
    expect(attempts).toBe(2);
    expect(bus.deadLetters).toHaveLength(0);
  });
});
