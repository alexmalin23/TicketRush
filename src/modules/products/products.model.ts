import { Injectable } from "../../core";
import { Queryable } from "../../database/database.constants";
import { DatabaseService } from "../../database/database.service";
import { PaginationQuery } from "../../common/validators/common.schemas";
import { CreateProductInput, UpdateProductInput } from "./products.schemas";

export interface Product {
  id: number;
  name: string;
  price: number;
  stock: number;
  createdAt: Date;
}

const COLUMNS = `id, name, price, stock, created_at AS "createdAt"`;
const UPDATABLE = ["name", "price", "stock"] as const;

/**
 * Data access only: SQL in, plain objects out. No HTTP, no business rules.
 *
 * Every method takes an optional `db` as the last argument. By default it uses the pool;
 * inside a transaction the Service passes the transaction's client instead.
 * Values are always sent as $1, $2... parameters, never concatenated (no SQL injection).
 */
@Injectable()
export class ProductsModel {
  constructor(private readonly database: DatabaseService) {}

  async findAll({ limit, offset }: PaginationQuery, db: Queryable = this.database): Promise<Product[]> {
    const { rows } = await db.query<Product>(
      `SELECT ${COLUMNS} FROM products ORDER BY id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows;
  }

  async findById(id: number, db: Queryable = this.database): Promise<Product | null> {
    const { rows } = await db.query<Product>(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /**
   * Locks the rows until the transaction ends, so two orders cannot sell the same
   * last item. ORDER BY id makes every transaction lock in the same order (no deadlocks).
   * Only meaningful when `db` is a transaction client.
   */
  async findByIdsForUpdate(ids: number[], db: Queryable): Promise<Product[]> {
    const { rows } = await db.query<Product>(
      `SELECT ${COLUMNS} FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [ids]
    );
    return rows;
  }

  async create(data: CreateProductInput, db: Queryable = this.database): Promise<Product> {
    const { rows } = await db.query<Product>(
      `INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [data.name, data.price, data.stock]
    );
    return rows[0];
  }

  async update(id: number, data: UpdateProductInput, db: Queryable = this.database): Promise<Product | null> {
    // Only the fields that were sent. Column names come from a fixed list, never from the client.
    const fields = UPDATABLE.filter((field) => data[field] !== undefined);
    const assignments = fields.map((field, i) => `${field} = $${i + 2}`).join(", ");

    const { rows } = await db.query<Product>(
      `UPDATE products SET ${assignments} WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, ...fields.map((field) => data[field])]
    );
    return rows[0] ?? null;
  }

  async delete(id: number, db: Queryable = this.database): Promise<boolean> {
    const { rowCount } = await db.query("DELETE FROM products WHERE id = $1", [id]);
    return rowCount === 1;
  }

  async decrementStock(id: number, quantity: number, db: Queryable): Promise<void> {
    await db.query("UPDATE products SET stock = stock - $2 WHERE id = $1", [id, quantity]);
  }
}
