import { Queue } from "bullmq";
import { ENV, Env } from "../../config/env";
import { Inject, Injectable, OnShutdown } from "../../core";

export const PAYMENTS_QUEUE = "payments";
export const PAYMENTS_DEAD_QUEUE = "payments-dead";
export const CHARGE_ATTEMPTS_IN_QUEUE = 5;

export interface PaymentJob {
  orderId: string;
}

/** BullMQ's blocking commands need their own connections, and it refuses a limit on command retries. */
export const queueConnection = (env: Env) => ({ url: env.REDIS_URL, maxRetriesPerRequest: null });

/**
 * BullMQ keeps a job as a Redis hash and its place in line in a list, plus a sorted set for delayed
 * retries. Delivery is at least once: a worker that dies mid-job loses its lock and the job runs again,
 * so the work must be safe to repeat (OrdersService.processPayment).
 */
@Injectable()
export class PaymentQueue implements OnShutdown {
  private queue?: Queue<PaymentJob>;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** The job id is the order: asking twice for the same order queues one job. */
  async enqueue(orderId: string): Promise<void> {
    this.queue ??= new Queue<PaymentJob>(PAYMENTS_QUEUE, {
      // Without this a request would wait for Redis to come back; failing lets the reconciler take over.
      connection: { ...queueConnection(this.env), enableOfflineQueue: false },
    });
    await this.queue.add(
      "charge",
      { orderId },
      {
        jobId: `order-${orderId}`,
        attempts: CHARGE_ATTEMPTS_IN_QUEUE,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: true,
        removeOnFail: true, // the worker copies it to the dead-letter queue first
      }
    );
  }

  async onShutdown(): Promise<void> {
    await this.queue?.close();
  }
}
