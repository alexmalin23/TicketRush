import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "../../core";
import { ENV, Env } from "../../config/env";
import { DatabaseService } from "../../database/database.service";

/** A violation is a bug: each counter must be zero after any load, however it ended. */
export interface Invariants {
  eventId: number;
  /** Zero means the system is correct. */
  violations: number;
  checks: {
    /** seats marked sold that have no ticket: sold, but the buyer got nothing */
    soldSeatsWithoutTicket: number;
    /** tickets for seats that are not sold */
    ticketsForUnsoldSeats: number;
    /** seats with more than one ticket: the same seat sold twice */
    seatsSoldTwice: number;
    /** issued orders whose ticket count differs from their seat count */
    issuedOrdersWithoutTickets: number;
    /** tickets whose order is not issued */
    ticketsWithoutIssuedOrder: number;
    /** the provider recorded a successful charge but the order failed: charged, nothing delivered */
    chargedButFailedOrders: number;
    /** an issued order the provider never charged successfully: tickets for free */
    issuedOrdersWithoutCharge: number;
    /** the charged amount differs from the order total */
    amountMismatches: number;
    /** provider charges that match no order at all */
    chargesWithoutOrder: number;
  };
  /**
   * Orders whose charge succeeded while the buyer never got an answer (pending_payment). Not a bug
   * for up to RECONCILE_AFTER_SECONDS plus one run: the reconciler finishes them.
   */
  awaitingReconciliation: number;
  totals: { ordersIssued: number; ordersFailed: number; ordersPending: number; ticketsIssued: number; seatsSold: number; capturedCents: number };
}

interface LedgerCharge {
  idempotencyKey: string;
  amountCents: number;
  status: "succeeded" | "declined";
}

@Injectable()
export class InvariantsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly database: DatabaseService
  ) {}

  /** Cross-checks the database against the payment provider's own ledger: two independent records. */
  async check(eventId: number): Promise<Invariants> {
    const event = await this.database.query("SELECT 1 FROM events WHERE id = $1", [eventId]);
    if (event.rowCount === 0) throw new NotFoundException(`Event ${eventId} not found`);

    const charges = await this.fetchLedger();
    const orderIds = charges.filter((c) => c.idempotencyKey.startsWith("order-")).map((c) => c.idempotencyKey.slice(6));

    const { rows } = await this.database.query<Record<string, number>>(
      `SELECT
         (SELECT count(*) FROM seats s WHERE s.event_id = $1 AND s.status = 'sold'
            AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.seat_id = s.id))::int AS "soldSeatsWithoutTicket",
         (SELECT count(*) FROM tickets t JOIN seats s ON s.id = t.seat_id
           WHERE t.event_id = $1 AND s.status <> 'sold')::int AS "ticketsForUnsoldSeats",
         (SELECT count(*) FROM (SELECT seat_id FROM tickets WHERE event_id = $1 GROUP BY seat_id HAVING count(*) > 1) d)::int AS "seatsSoldTwice",
         (SELECT count(*) FROM orders o WHERE o.event_id = $1 AND o.status = 'issued'
            AND (SELECT count(*) FROM tickets t WHERE t.order_id = o.id)
             <> (SELECT count(*) FROM order_items i WHERE i.order_id = o.id))::int AS "issuedOrdersWithoutTickets",
         (SELECT count(*) FROM tickets t JOIN orders o ON o.id = t.order_id
           WHERE t.event_id = $1 AND o.status <> 'issued')::int AS "ticketsWithoutIssuedOrder",
         (SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'sold')::int AS "seatsSold",
         (SELECT count(*) FROM tickets WHERE event_id = $1)::int AS "ticketsIssued",
         (SELECT count(*) FROM orders WHERE event_id = $1 AND status = 'issued')::int AS "ordersIssued",
         (SELECT count(*) FROM orders WHERE event_id = $1 AND status = 'failed')::int AS "ordersFailed",
         (SELECT count(*) FROM orders WHERE event_id = $1 AND status = 'pending_payment')::int AS "ordersPending"`,
      [eventId]
    );
    const db = rows[0];

    const orders = await this.database.query<{ id: string; status: string; totalCents: number; eventId: number }>(
      `SELECT id, status, total_cents AS "totalCents", event_id AS "eventId" FROM orders WHERE id = ANY($1::uuid[])`,
      [orderIds]
    );
    const orderById = new Map(orders.rows.map((o) => [o.id, o]));
    const chargeByOrder = new Map(charges.map((c) => [c.idempotencyKey.slice(6), c]));

    let chargedButFailedOrders = 0;
    let amountMismatches = 0;
    let chargesWithoutOrder = 0;
    let awaitingReconciliation = 0;
    let capturedCents = 0;
    for (const charge of charges) {
      const order = orderById.get(charge.idempotencyKey.slice(6));
      if (!order) {
        chargesWithoutOrder++;
        continue;
      }
      if (order.eventId !== eventId) continue; // another event's order
      if (charge.status === "succeeded") capturedCents += charge.amountCents;
      if (charge.status === "succeeded" && order.status === "failed") chargedButFailedOrders++;
      if (charge.status === "succeeded" && order.status === "pending_payment") awaitingReconciliation++;
      if (charge.amountCents !== order.totalCents) amountMismatches++;
    }

    const issued = await this.database.query<{ id: string }>("SELECT id FROM orders WHERE event_id = $1 AND status = 'issued'", [eventId]);
    const issuedOrdersWithoutCharge = issued.rows.filter((o) => chargeByOrder.get(o.id)?.status !== "succeeded").length;

    const checks = {
      soldSeatsWithoutTicket: db.soldSeatsWithoutTicket,
      ticketsForUnsoldSeats: db.ticketsForUnsoldSeats,
      seatsSoldTwice: db.seatsSoldTwice,
      issuedOrdersWithoutTickets: db.issuedOrdersWithoutTickets,
      ticketsWithoutIssuedOrder: db.ticketsWithoutIssuedOrder,
      chargedButFailedOrders,
      issuedOrdersWithoutCharge,
      amountMismatches,
      chargesWithoutOrder,
    };
    return {
      eventId,
      violations: Object.values(checks).reduce((sum, n) => sum + n, 0),
      checks,
      awaitingReconciliation,
      totals: {
        ordersIssued: db.ordersIssued,
        ordersFailed: db.ordersFailed,
        ordersPending: db.ordersPending,
        ticketsIssued: db.ticketsIssued,
        seatsSold: db.seatsSold,
        capturedCents,
      },
    };
  }

  private async fetchLedger(): Promise<LedgerCharge[]> {
    try {
      const response = await fetch(new URL("/ledger", this.env.PAYMENTS_PROVIDER_URL), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`ledger answered ${response.status}`);
      return ((await response.json()) as { charges: LedgerCharge[] }).charges;
    } catch {
      throw new ServiceUnavailableException("Payment provider ledger unreachable", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
    }
  }
}
