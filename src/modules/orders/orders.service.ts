import { ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException, OnInit, OnShutdown } from "../../core";
import { ENV, Env } from "../../config/env";
import { DatabaseService } from "../../database/database.service";
import { EventsModel } from "../events/events.model";
import { SeatCache } from "../events/seat-cache";
import { HOLD_STORE, HoldStore } from "../holds/hold-store";
import { IdempotencyService, StoredResponse } from "../idempotency/idempotency.service";
import { PaymentsClient } from "../payments/payments.client";
import { Ticket, TicketsModel } from "../tickets/tickets.model";
import { Order, OrdersModel } from "./orders.model";
import { PaymentQueue } from "./payment-queue";
import { CreateOrderInput } from "./orders.schemas";

/** A charge that times out may or may not have happened; asking again with the same key is safe. */
const CHARGE_ATTEMPTS = 3;
/** Orders finished per reconciler run and replica; the rest wait for the next run. */
const RECONCILE_BATCH = 20;

@Injectable()
export class OrdersService implements OnInit, OnShutdown {
  private readonly logger: Logger;
  private reconcileTimer?: NodeJS.Timeout;
  private reconciling: Promise<number> = Promise.resolve(0);

  constructor(
    @Inject(ENV) private readonly env: Env,
    logger: Logger,
    private readonly database: DatabaseService,
    private readonly eventsModel: EventsModel,
    @Inject(HOLD_STORE) private readonly holds: HoldStore,
    private readonly ordersModel: OrdersModel,
    private readonly ticketsModel: TicketsModel,
    private readonly payments: PaymentsClient,
    private readonly idempotency: IdempotencyService,
    private readonly seatCache: SeatCache,
    private readonly paymentQueue: PaymentQueue
  ) {
    this.logger = logger.child("Orders");
  }

  /** Every replica runs the reconciler; leaseStuck makes sure each order is finished by one of them. */
  onInit(): void {
    if (this.env.RECONCILE_INTERVAL_SECONDS === 0) return;
    this.reconcileTimer = setInterval(() => {
      this.reconciling = this.reconciling.then(() => this.reconcileStuckOrders());
    }, this.env.RECONCILE_INTERVAL_SECONDS * 1000);
  }

  async onShutdown(): Promise<void> {
    clearInterval(this.reconcileTimer);
    await this.reconciling; // a run in progress finishes before the database pool closes
  }

  /**
   * Finishes orders left pending_payment because the request that created them died (crash,
   * restart) or never got the charge outcome (timeout). Asking the provider again with the
   * order's key is safe: it returns the charge already made, or makes the one the buyer asked for.
   * Every step is a guarded transition, so a request still working on the same order cannot
   * finish it twice. Returns how many orders were looked at.
   */
  async reconcileStuckOrders(): Promise<number> {
    let stuck;
    try {
      stuck = await this.ordersModel.leaseStuck(this.env.RECONCILE_AFTER_SECONDS, RECONCILE_BATCH);
    } catch (error) {
      this.logger.error("Reconciler could not read stuck orders", { error: String(error) });
      return 0;
    }
    for (const order of stuck) {
      try {
        const outcome = await this.payments.charge({ idempotencyKey: `order-${order.id}`, amountCents: order.totalCents });
        await this.ordersModel.recordPayment(order.id, outcome.status, "providerRef" in outcome ? outcome.providerRef : null);
        if (outcome.status === "succeeded") await this.sellAndIssue(order.id, order.userId, order.eventId, order.seatIds);
        if (outcome.status === "declined") await this.releaseAfterDecline(order.id, order.userId, order.eventId, order.seatIds);
        // timeout: still unknown; the lease runs out and the next run asks again.
        this.logger.info("Reconciled a stuck order", { orderId: order.id, outcome: outcome.status });
      } catch (error) {
        // Provider unreachable from this replica, or a sale that failed. Keeping the lease would let a
        // replica that can never succeed take the order again every time; give it back instead.
        this.logger.error("Could not reconcile an order", { orderId: order.id, error: String(error) });
        await this.ordersModel.releaseLease(order.id, this.env.RECONCILE_AFTER_SECONDS).catch(() => undefined);
      }
    }
    return stuck.length;
  }

  /** A retry with the same Idempotency-Key never creates a second order or a second charge. */
  create(userId: number, idempotencyKey: string, input: CreateOrderInput): Promise<StoredResponse> {
    return this.idempotency.runOnce(userId, idempotencyKey, input, () => this.placeOrder(userId, input));
  }

  /**
   * Three steps, and the card is charged BETWEEN two short transactions: holding a database
   * connection (and row locks) across a call to an external system would stall every other buyer.
   */
  private async placeOrder(userId: number, input: CreateOrderInput): Promise<StoredResponse> {
    const { orderId, totalCents } = await this.createPendingOrder(userId, input);

    if (this.env.ORDER_PROCESSING === "async") {
      await this.paymentQueue.enqueue(orderId).catch((error) => {
        // The order is safe in Postgres, and the reconciler finishes pending orders no job is working on.
        this.logger.error("Could not queue a payment", { orderId, error: String(error) });
      });
      return { status: 202, body: await this.ordersModel.findOwned(orderId, userId) };
    }

    const outcome = await this.chargeWithRetries(orderId, totalCents);

    if (outcome.status === "succeeded") {
      await this.sellAndIssue(orderId, userId, input.eventId, input.seatIds);
      return { status: 201, body: await this.ordersModel.findOwned(orderId, userId) };
    }
    if (outcome.status === "declined") {
      await this.releaseAfterDecline(orderId, userId, input.eventId, input.seatIds);
      throw new HttpException(402, "Payment declined", { orderId }, "PAYMENT_DECLINED");
    }
    // The provider never answered: the buyer may or may not have been charged. The order stays
    // pending_payment with its seats held until the outcome is known; the buyer polls GET /orders/:id.
    return { status: 202, body: await this.ordersModel.findOwned(orderId, userId) };
  }

  /**
   * The queue delivers a job at least once, and two workers can run the same order at the same time.
   * Repeating is safe: the provider key makes it one charge, and sellAndIssue moves the status with a
   * guard, so one run sells. An unknown outcome throws: the queue retries it with a growing delay.
   */
  async processPayment(orderId: string): Promise<void> {
    const order = await this.ordersModel.findPendingForPayment(orderId);
    if (!order) return; // already decided by an earlier run or by the reconciler

    let outcome;
    try {
      outcome = await this.payments.charge({ idempotencyKey: `order-${order.id}`, amountCents: order.totalCents });
    } catch (error) {
      await this.ordersModel.recordPayment(order.id, "unreachable", null);
      throw error;
    }
    await this.ordersModel.recordPayment(order.id, outcome.status, "providerRef" in outcome ? outcome.providerRef : null);
    if (outcome.status === "succeeded") await this.sellAndIssue(order.id, order.userId, order.eventId, order.seatIds);
    if (outcome.status === "declined") await this.releaseAfterDecline(order.id, order.userId, order.eventId, order.seatIds);
    if (outcome.status === "timeout") throw new Error(`Charge for order ${order.id} timed out`);
  }

  /** Transaction 1: prove the buyer holds every seat, create the order, keep the seats for the payment. */
  private createPendingOrder(userId: number, input: CreateOrderInput): Promise<{ orderId: string; totalCents: number }> {
    const seatIds = [...input.seatIds].sort((a, b) => a - b);

    return this.database.transaction(async (client) => {
      const event = await this.eventsModel.findById(input.eventId, client);
      if (!event) throw new NotFoundException(`Event ${input.eventId} not found`);

      // Locks the seats (two orders for the same seats serialize here) and extends the hold for the payment.
      const held = await this.holds.claimForOrder(input.eventId, userId, seatIds, client);
      if (held.length < seatIds.length) {
        const heldIds = new Set(held.map((seat) => seat.id));
        throw new ConflictException(
          "Every seat must be held by you and not expired",
          { seatIds: seatIds.filter((id) => !heldIds.has(id)) },
          "HOLD_INVALID"
        );
      }

      const pendingOrderId = await this.ordersModel.findPendingOrderFor(seatIds, client);
      if (pendingOrderId) {
        throw new ConflictException("These seats are already part of an order awaiting payment", { orderId: pendingOrderId }, "ORDER_IN_PROGRESS");
      }

      const totalCents = held.reduce((sum, seat) => sum + seat.priceCents, 0);
      const order = await this.ordersModel.create(userId, input.eventId, totalCents, client);
      await this.ordersModel.addItems(order.id, held, client);
      return { orderId: order.id, totalCents };
    });
  }

  /**
   * Step 2: charge. The provider key is derived from the order, so every attempt for this order is
   * the same payment: a retry after a timeout finds out the real outcome and can never charge twice.
   */
  private async chargeWithRetries(orderId: string, amountCents: number) {
    for (let attempt = 1; attempt <= CHARGE_ATTEMPTS; attempt++) {
      let outcome;
      try {
        outcome = await this.payments.charge({ idempotencyKey: `order-${orderId}`, amountCents });
      } catch (error) {
        // Provider unreachable: the request never arrived, so nothing was charged.
        await this.ordersModel.recordPayment(orderId, "unreachable", null);
        await this.failUnchargedOrder(orderId);
        throw error;
      }
      await this.ordersModel.recordPayment(orderId, outcome.status, "providerRef" in outcome ? outcome.providerRef : null);
      if (outcome.status !== "timeout") return outcome;
      this.logger.warn("Charge attempt timed out, asking again with the same key", { orderId, attempt });
    }
    return { status: "timeout" as const };
  }

  /**
   * Transaction 3a: the charge succeeded. Sell the seats, issue the tickets and complete the order,
   * all together or none of it: a half-finished sale (paid but no tickets, tickets for unsold seats)
   * must never be visible. If anything fails the order stays pending_payment with its seats held,
   * which a reconciliation can recognise (a successful charge, no tickets).
   */
  private async sellAndIssue(orderId: string, userId: number, eventId: number, seatIds: number[]): Promise<void> {
    await this.database.transaction(async (client) => {
      if (!(await this.ordersModel.moveStatus(orderId, "pending_payment", "paid", client))) return; // already decided
      const sold = await this.holds.sell(userId, seatIds, client);
      if (sold !== seatIds.length) {
        this.logger.error("Charged but seats could not be sold", { orderId, expected: seatIds.length, sold });
        throw new Error(`Order ${orderId}: charged but only ${sold} of ${seatIds.length} seats could be sold`);
      }
      await this.ticketsModel.issueForSeats(orderId, eventId, seatIds, client);
      await this.ordersModel.moveStatus(orderId, "paid", "issued", client);
    });
    // Holds kept in Redis would otherwise outlive the sale, and availability would count the seat
    // twice (sold in Postgres and held in Redis) until they expire. A no-op for Postgres holds.
    await this.holds.release(eventId, userId, seatIds);
  }

  /**
   * Step 3b: a decline is final. The order fails and, per the rules, the seats are released at once.
   * Release runs after the status change, since seats in an order awaiting payment are never released;
   * if the process dies in between, the holds simply expire.
   */
  private async releaseAfterDecline(orderId: string, userId: number, eventId: number, seatIds: number[]): Promise<void> {
    if (!(await this.ordersModel.moveStatus(orderId, "pending_payment", "failed"))) return;
    await this.holds.release(eventId, userId, seatIds);
    await this.seatCache.invalidateSeats(eventId, seatIds);
  }

  /** The card was never touched: fail the order but keep the hold so the buyer can try again right away. */
  private async failUnchargedOrder(orderId: string): Promise<void> {
    await this.ordersModel.moveStatus(orderId, "pending_payment", "failed");
  }

  async findOne(orderId: string, userId: number): Promise<Order> {
    // Someone else's order is a 404, not a 403: ids must not reveal which orders exist.
    const order = await this.ordersModel.findOwned(orderId, userId);
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    return order;
  }

  /** Tickets exist only for an issued order; before that the answer is "not yet", not "none". */
  async tickets(orderId: string, userId: number): Promise<Ticket[]> {
    const order = await this.findOne(orderId, userId);
    if (order.status !== "issued") {
      throw new ConflictException("Tickets are available once the order is issued", { status: order.status }, "ORDER_NOT_ISSUED");
    }
    return this.ticketsModel.findByOrder(orderId);
  }

  findMine(userId: number): Promise<Order[]> {
    return this.ordersModel.findAllOwned(userId);
  }
}
