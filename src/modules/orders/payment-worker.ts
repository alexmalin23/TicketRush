import { Job, Queue, Worker } from "bullmq";
import { ENV, Env } from "../../config/env";
import { Inject, Injectable, Logger, OnShutdown } from "../../core";
import { OrdersService } from "./orders.service";
import { CHARGE_ATTEMPTS_IN_QUEUE, PAYMENTS_DEAD_QUEUE, PAYMENTS_QUEUE, PaymentJob, queueConnection } from "./payment-queue";

/** Takes payment jobs off the queue. Runs in its own process (src/worker.ts), on the same business logic. */
@Injectable()
export class PaymentWorker implements OnShutdown {
  private readonly logger: Logger;
  private worker?: Worker<PaymentJob>;
  private dead?: Queue;

  constructor(
    @Inject(ENV) private readonly env: Env,
    logger: Logger,
    private readonly orders: OrdersService
  ) {
    this.logger = logger.child("PaymentWorker");
  }

  start(): void {
    const connection = queueConnection(this.env);
    this.dead = new Queue(PAYMENTS_DEAD_QUEUE, { connection });
    this.worker = new Worker<PaymentJob>(PAYMENTS_QUEUE, (job) => this.orders.processPayment(job.data.orderId), {
      connection,
      concurrency: this.env.WORKER_CONCURRENCY,
    });
    this.worker.on("failed", (job, error) => void this.onFailed(job, error));
    this.worker.on("error", (error) => this.logger.error("Payment worker error", { error: String(error) }));
  }

  /**
   * Out of attempts means the charge outcome is still unknown, so the seats stay held: releasing them
   * could resell a seat the buyer paid for. The order stays pending and the reconciler keeps asking the
   * provider. The dead-letter entry is there for an operator to see.
   */
  private async onFailed(job: Job<PaymentJob> | undefined, error: Error): Promise<void> {
    if (!job || job.attemptsMade < CHARGE_ATTEMPTS_IN_QUEUE) return;
    this.logger.error("Payment job out of attempts", { orderId: job.data.orderId, error: String(error) });
    await this.dead?.add("charge", { ...job.data, reason: error.message }).catch(() => undefined);
  }

  async onShutdown(): Promise<void> {
    await this.worker?.close(); // waits for the jobs in progress
    await this.dead?.close();
  }
}
