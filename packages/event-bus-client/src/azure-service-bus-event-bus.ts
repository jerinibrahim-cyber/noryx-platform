import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from "@azure/service-bus";
import { DefaultAzureCredential } from "@azure/identity";
import type { EventEnvelope } from "@noryx/shared-types";
import type { EventBus, EventHandler } from "./event-bus";

export interface AzureServiceBusEventBusOptions {
  /** Fully-qualified namespace, e.g. "noryx-prod.servicebus.windows.net" — used with a managed identity credential. Prefer this over a connection string in production (Pre-Development Readiness Review §7.5: service-to-service auth via managed identities, not shared static keys). */
  fullyQualifiedNamespace?: string;
  /** Local/dev fallback only — never committed, sourced from the secrets vault. */
  connectionString?: string;
  /** Service Bus topic name — one topic per environment, one subscription per consumer service, matching the module-manifest's `key`. */
  topicName: string;
  subscriptionName: string;
  maxDeliveryAttempts?: number;
}

/**
 * Production event bus adapter, backed by Azure Service Bus topics/subscriptions
 * (System Architecture v1 §5 — the managed broker recommendation; §11 documents
 * Kafka as the future graduation path if Orbis's volume outgrows this).
 *
 * Dead-lettering is Service Bus's own built-in DLQ, not reimplemented here —
 * a message that exceeds maxDeliveryAttempts is moved by the broker itself
 * and inspectable via the topic's dead-letter sub-queue.
 */
export class AzureServiceBusEventBus implements EventBus {
  private client: ServiceBusClient;
  private opts: AzureServiceBusEventBusOptions;

  constructor(opts: AzureServiceBusEventBusOptions, client?: ServiceBusClient) {
    this.opts = opts;
    if (client) {
      this.client = client;
    } else if (opts.connectionString) {
      this.client = new ServiceBusClient(opts.connectionString);
    } else if (opts.fullyQualifiedNamespace) {
      this.client = new ServiceBusClient(
        opts.fullyQualifiedNamespace,
        new DefaultAzureCredential(),
      );
    } else {
      throw new Error(
        "AzureServiceBusEventBus requires either connectionString or fullyQualifiedNamespace",
      );
    }
  }

  async publish<T>(event: EventEnvelope<T>): Promise<void> {
    const sender = this.client.createSender(this.opts.topicName);
    try {
      await sender.sendMessages({
        body: event,
        subject: event.type,
        messageId: event.id,
        applicationProperties: {
          tenantId: event.tenantId,
          eventType: event.type,
          version: event.version,
        },
      });
    } finally {
      await sender.close();
    }
  }

  async subscribe<T>(
    eventType: string,
    handler: EventHandler<T>,
  ): Promise<void> {
    const receiver = this.client.createReceiver(
      this.opts.topicName,
      this.opts.subscriptionName,
      {
        maxAutoLockRenewalDurationInMs: 5 * 60 * 1000,
      },
    );

    receiver.subscribe({
      processMessage: async (message: ServiceBusReceivedMessage) => {
        if (message.subject !== eventType) return; // this subscription's filter should already scope this; belt-and-braces.
        await handler(message.body as EventEnvelope<T>);
      },
      processError: async (args) => {
        // Structured logging hook — wired to OpenTelemetry in each service's
        // bootstrap (System Architecture v1 §5, Readiness Review §7.7).
        console.error(
          `[event-bus:${this.opts.subscriptionName}] error`,
          args.error,
        );
      },
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
