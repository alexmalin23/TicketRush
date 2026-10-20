import { Injectable } from "../../core";
import { Queryable } from "../../database/database.constants";
import { DatabaseService } from "../../database/database.service";

export interface OrderItem {
  productId: number;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  id: number;
  userId: number;
  total: number;
  createdAt: Date;
  items: OrderItem[];
}

// One query returns each order with its items as a JSON array.
const SELECT_ORDERS = `
  SELECT o.id,
         o.user_id    AS "userId",
         o.total,
         o.created_at AS "createdAt",
         COALESCE(
           json_agg(
             json_build_object('productId', i.product_id, 'quantity', i.quantity, 'unitPrice', i.unit_price)
             ORDER BY i.product_id
           ) FILTER (WHERE i.order_id IS NOT NULL),
           '[]'
         ) AS items
    FROM orders o
    LEFT JOIN order_items i ON i.order_id = o.id`;

@Injectable()
export class OrdersModel {
  constructor(private readonly database: DatabaseService) {}

  async create(userId: number, total: number, db: Queryable = this.database): Promise<Omit<Order, "items">> {
    const { rows } = await db.query<Omit<Order, "items">>(
      `INSERT INTO orders (user_id, total) VALUES ($1, $2)
       RETURNING id, user_id AS "userId", total, created_at AS "createdAt"`,
      [userId, total]
    );
    return rows[0];
  }

  /** Inserts all items in one round trip using unnest() over parallel arrays. */
  async addItems(orderId: number, items: OrderItem[], db: Queryable = this.database): Promise<void> {
    await db.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
       SELECT $1, * FROM unnest($2::int[], $3::int[], $4::numeric[])`,
      [
        orderId,
        items.map((item) => item.productId),
        items.map((item) => item.quantity),
        items.map((item) => item.unitPrice),
      ]
    );
  }

  async findById(id: number, db: Queryable = this.database): Promise<Order | null> {
    const { rows } = await db.query<Order>(`${SELECT_ORDERS} WHERE o.id = $1 GROUP BY o.id`, [id]);
    return rows[0] ?? null;
  }

  async findByUser(userId: number, db: Queryable = this.database): Promise<Order[]> {
    const { rows } = await db.query<Order>(
      `${SELECT_ORDERS} WHERE o.user_id = $1 GROUP BY o.id ORDER BY o.id`,
      [userId]
    );
    return rows;
  }
}
