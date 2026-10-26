import { Injectable } from "../../core";
import { Queryable } from "../../database/database.constants";
import { DatabaseService } from "../../database/database.service";

export interface IdempotencyRecord {
  requestHash: string;
  state: "in_progress" | "completed";
  responseCode: number | null;
  responseBody: unknown;
  createdAt: Date;
}

@Injectable()
export class IdempotencyModel {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Saves (userId, key) as "in progress", only if it is not there yet. Returns true if this call
   * saved it, false if the key already existed. Two concurrent calls with one key: exactly one true.
   */
  async saveKeyIfNew(userId: number, key: string, requestHash: string, db: Queryable = this.database): Promise<boolean> {
    const { rowCount } = await db.query(
      `INSERT INTO idempotency_keys (user_id, key, state, request_hash)
       VALUES ($1, $2, 'in_progress', $3)
       ON CONFLICT (user_id, key) DO NOTHING`,
      [userId, key, requestHash]
    );
    // DO NOTHING skips a duplicate: 0 rows means another request already saved this key.
    return (rowCount ?? 0) > 0;
  }

  async findKey(userId: number, key: string, db: Queryable = this.database): Promise<IdempotencyRecord | null> {
    const { rows } = await db.query<IdempotencyRecord>(
      `SELECT request_hash AS "requestHash", state, response_code AS "responseCode",
              response_body AS "responseBody", created_at AS "createdAt"
         FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
      [userId, key]
    );
    return rows[0] ?? null;
  }

  async saveResponse(userId: number, key: string, code: number, body: unknown, db: Queryable = this.database): Promise<void> {
    await db.query(
      `UPDATE idempotency_keys SET state = 'completed', response_code = $3, response_body = $4
        WHERE user_id = $1 AND key = $2`,
      [userId, key, code, JSON.stringify(body)]
    );
  }

  /** Deletes the key: the next request with it runs again (after a crash, or once expired). */
  async deleteKey(userId: number, key: string, db: Queryable = this.database): Promise<void> {
    await db.query("DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2", [userId, key]);
  }
}
