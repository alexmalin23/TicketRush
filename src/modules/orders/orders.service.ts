import { ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException } from "../../core";
import { ENV, Env } from "../../config/env";
import { DatabaseService } from "../../database/database.service";
import { EventsModel } from "../events/events.model";
import { IdempotencyService, StoredResponse } from "../idempotency/idempotency.service";
import { PaymentsClient } from "../payments/payments.client";
import { SeatsModel } from "../seats/seats.model";
import { Order, OrdersModel } from "./orders.model";
import { CreateOrderInput } from "./orders.schemas";

/** A charge that times out may or may not have happened; asking again with the same key is safe. */
const CHARGE_ATTEMPTS = 3;

@Injectable()
export class OrdersService {
  private readonly logger: Logger;

  constructor(
    @Inject(ENV) private readonly env: Env,
    logger: Logger,
    private readonly database: DatabaseService,
    private readonly eventsModel: EventsModel,
    private readonly seatsModel: SeatsModel,
    private readonly ordersModel: OrdersModel,
    private readonly payments: PaymentsClient,
    private readonly idempotency: IdempotencyService
  ) {
    this.logger = logger.child("Orders");
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

    const outcome = await this.chargeWithRetries(orderId, totalCents);

    if (outcome.status === "succeeded") {
      await this.markPaid(orderId, userId, input.seatIds);
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

  /** Transaction 1: prove the buyer holds every seat, create the order, keep the seats for the payment. */
  private createPendingOrder(userId: number, input: CreateOrderInput): Promise<{ orderId: string; totalCents: number }> {
    const seatIds = [...input.seatIds].sort((a, b) => a - b);

    return this.database.transaction(async (client) => {
      const event = await this.eventsModel.findById(input.eventId, client);
      if (!event) throw new NotFoundException(`Event ${input.eventId} not found`);

      // FOR UPDATE: two orders for the same seats serialize here; the second one waits, then sees the first.
      const held = await this.seatsModel.lockSeatsHeldByUser(input.eventId, userId, seatIds, client);
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
      // Payment can take seconds; the hold must outlive it or the seats could be sold to someone else.
      await this.seatsModel.extendHolds(seatIds, this.env.HOLD_TTL_SECONDS, client);
      return { orderId: order.id, totalCents };
    });
  }

  /**
   * Step 2: charge. The provider key is derived from the order, so every attempt for this order is
   * the same payment: a retry after a timeout learns the real outcome and can never charge twice.
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

  /** Transaction 3a: the charge succeeded, so the seats are sold and the order is paid, together or not at all. */
  private markPaid(orderId: string, userId: number, seatIds: number[]): Promise<void> {
    return this.database.transaction(async (client) => {
      if (!(await this.ordersModel.moveStatus(orderId, "pending_payment", "paid", client))) return; // already decided
      const sold = await this.seatsModel.sellHeldSeats(userId, seatIds, client);
      if (sold !== seatIds.length) {
        // The buyer was charged but a seat is gone. Rolling back leaves the order pending for reconciliation.
        this.logger.error("Charged but seats could not be sold", { orderId, expected: seatIds.length, sold });
        throw new Error(`Order ${orderId}: charged but only ${sold} of ${seatIds.length} seats could be sold`);
      }
    });
  }

  /** Transaction 3b: a decline is final. The order fails and, per the rules, the seats are released at once. */
  private releaseAfterDecline(orderId: string, userId: number, eventId: number, seatIds: number[]): Promise<void> {
    return this.database.transaction(async (client) => {
      if (!(await this.ordersModel.moveStatus(orderId, "pending_payment", "failed", client))) return;
      await this.seatsModel.releaseHoldsOf(eventId, userId, seatIds, client);
    });
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

  findMine(userId: number): Promise<Order[]> {
    return this.ordersModel.findAllOwned(userId);
  }
}
