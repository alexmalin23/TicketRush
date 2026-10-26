import { Injectable } from "../../core";
import { Queryable } from "../../database/database.constants";
import { DatabaseService } from "../../database/database.service";

export type OrderStatus = "pending_payment" | "paid" | "issued" | "failed" | "expired";

export interface OrderItem {
  seatId: number;
  section: string;
  row: string;
  number: number;
  priceCents: number;
}

export interface Order {
  id: string;
  eventId: number;
  status: OrderStatus;
  totalCents: number;
  items: OrderItem[];
  createdAt: Date;
}

/** An order row without its items: what a status change needs. */
interface OrderRow {
  id: string;
  userId: number;
  eventId: number;
  status: OrderStatus;
  totalCents: number;
}

const SELECT_ORDERS = `
  SELECT o.id, o.event_id AS "eventId", o.status, o.total_cents AS "totalCents", o.created_at AS "createdAt",
         COALESCE(json_agg(json_build_object(
           'seatId', i.seat_id, 'section', s.section, 'row', s.row_label, 'number', s.number, 'priceCents', i.price_cents
         ) ORDER BY s.section, s.row_label, s.number) FILTER (WHERE i.order_id IS NOT NULL), '[]') AS items
    FROM orders o
    LEFT JOIN order_items i ON i.order_id = o.id
    LEFT JOIN seats s ON s.id = i.seat_id`;

@Injectable()
export class OrdersModel {
  constructor(private readonly database: DatabaseService) {}

  async create(userId: number, eventId: number, totalCents: number, db: Queryable = this.database): Promise<OrderRow> {
    const { rows } = await db.query<OrderRow>(
      `INSERT INTO orders (user_id, event_id, status, total_cents) VALUES ($1, $2, 'pending_payment', $3)
       RETURNING id, user_id AS "userId", event_id AS "eventId", status, total_cents AS "totalCents"`,
      [userId, eventId, totalCents]
    );
    return rows[0];
  }

  async addItems(orderId: string, seats: { id: number; priceCents: number }[], db: Queryable = this.database): Promise<void> {
    await db.query(
      `INSERT INTO order_items (order_id, seat_id, price_cents)
       SELECT $1, * FROM unnest($2::bigint[], $3::int[])`,
      [orderId, seats.map((s) => s.id), seats.map((s) => s.priceCents)]
    );
  }

  /**
   * Guarded transition: only moves the order if it is still in `expected`. Zero rows means
   * someone else already moved it; the caller must not overwrite their decision.
   */
  async moveStatus(orderId: string, expected: OrderStatus, next: OrderStatus, db: Queryable = this.database): Promise<boolean> {
    const { rowCount } = await db.query(
      "UPDATE orders SET status = $3, updated_at = now() WHERE id = $1 AND status = $2",
      [orderId, expected, next]
    );
    return (rowCount ?? 0) > 0;
  }

  async findOwned(orderId: string, userId: number, db: Queryable = this.database): Promise<Order | null> {
    const { rows } = await db.query<Order>(`${SELECT_ORDERS} WHERE o.id = $1 AND o.user_id = $2 GROUP BY o.id`, [orderId, userId]);
    return rows[0] ?? null;
  }

  async findAllOwned(userId: number, db: Queryable = this.database): Promise<Order[]> {
    const { rows } = await db.query<Order>(
      `${SELECT_ORDERS} WHERE o.user_id = $1 GROUP BY o.id ORDER BY o.created_at DESC, o.id`,
      [userId]
    );
    return rows;
  }

  /** The order awaiting payment that already contains any of these seats, if there is one. */
  async findPendingOrderFor(seatIds: number[], db: Queryable = this.database): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT o.id FROM orders o JOIN order_items i ON i.order_id = o.id
        WHERE i.seat_id = ANY($1::bigint[]) AND o.status = 'pending_payment' LIMIT 1`,
      [seatIds]
    );
    return rows[0]?.id ?? null;
  }

  /** The next payment attempt number for an order: attempts are 1, 2, 3... and unique per order. */
  async recordPayment(
    orderId: string,
    status: "pending" | "succeeded" | "declined" | "timeout" | "unreachable",
    providerRef: string | null,
    db: Queryable = this.database
  ): Promise<void> {
    await db.query(
      `INSERT INTO payments (order_id, attempt, status, provider_ref)
       SELECT $1, COALESCE(max(attempt), 0) + 1, $2, $3 FROM payments WHERE order_id = $1`,
      [orderId, status, providerRef]
    );
  }
}
