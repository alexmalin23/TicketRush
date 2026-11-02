import { Injectable } from "../../core";
import { Queryable } from "../../database/database.constants";
import { DatabaseService } from "../../database/database.service";

/**
 * THE definition of "this seat can be taken", used by every query that reads or claims
 * availability. Holds expire lazily: an expired hold is never cleaned up by a job, it simply
 * stops counting. Keeping the rule in one place means the seat map, the summary and the
 * hold logic can never disagree about which seats are free.
 */
export const SEAT_IS_AVAILABLE = `(status = 'available' OR (status = 'held' AND held_until < now()))`;

/**
 * Its exact complement for held seats: a hold that still counts. Together the two rules leave no
 * instant where a seat is neither available nor held.
 *
 * now() is the start time of the current transaction, not the wall clock. Inside a transaction that
 * waited for a lock, a hold that expired during the wait still counts as active: the error is always
 * on the safe side (a seat frees up slightly late, never early).
 */
export const HOLD_IS_ACTIVE = `(status = 'held' AND held_until >= now())`;

/**
 * A seat in an order that awaits payment is committed to that payment: releasing it mid-charge would
 * let another buyer take a seat the first one is paying for.
 */
const NOT_IN_PENDING_ORDER = `NOT EXISTS (
  SELECT 1 FROM order_items oi JOIN orders po ON po.id = oi.order_id
   WHERE oi.seat_id = seats.id AND po.status = 'pending_payment')`;

export interface SectionAvailability {
  name: string;
  available: number;
  total: number;
}

export interface SectionPrice {
  name: string;
  priceCents: number;
}

/** What the public seat map shows: never who holds a seat, only whether it can be taken. */
export interface SeatView {
  id: number;
  row: string;
  number: number;
  priceCents: number;
  status: "available" | "unavailable";
}

/** A seat as returned to its holder. */
export interface HeldSeat {
  id: number;
  section: string;
  row: string;
  number: number;
  priceCents: number;
  heldUntil: Date;
}

@Injectable()
export class SeatsModel {
  constructor(private readonly database: DatabaseService) { }

  async availabilityByEvent(eventId: number, db: Queryable = this.database): Promise<SectionAvailability[]> {
    const { rows } = await db.query<SectionAvailability>(
      `SELECT section AS name,
              count(*) FILTER (WHERE ${SEAT_IS_AVAILABLE})::int AS available,
              count(*)::int AS total
         FROM seats
        WHERE event_id = $1
        GROUP BY section
        ORDER BY section`,
      [eventId]
    );
    return rows;
  }

  async sectionPrices(eventId: number, db: Queryable = this.database): Promise<SectionPrice[]> {
    const { rows } = await db.query<SectionPrice>(
      `SELECT section AS name, min(price_cents) AS "priceCents"
         FROM seats
        WHERE event_id = $1
        GROUP BY section
        ORDER BY section`,
      [eventId]
    );
    return rows;
  }

  async bySection(eventId: number, section: string, db: Queryable = this.database): Promise<SeatView[]> {
    // Natural order: row "2" before row "10", and letter rows sort alphabetically.
    const { rows } = await db.query<SeatView>(
      `SELECT id, row_label AS "row", number, price_cents AS "priceCents",
              CASE WHEN ${SEAT_IS_AVAILABLE} THEN 'available' ELSE 'unavailable' END AS status
         FROM seats
        WHERE event_id = $1 AND section = $2
        ORDER BY length(row_label), row_label, number`,
      [eventId, section]
    );
    return rows;
  }

  /**
   * Takes only the seats that are still available at the moment of the write: the check and the
   * write are one statement, so a seat taken an instant earlier by someone else just does not match.
   * Returns the rows it actually took (possibly fewer than requested).
   */
  async holdSeatsIfAvailable(
    eventId: number,
    seatIds: number[],
    userId: number,
    ttlSeconds: number,
    db: Queryable = this.database
  ): Promise<HeldSeat[]> {
    const { rows } = await db.query<HeldSeat>(
      `UPDATE seats
        SET status = 'held', held_by = $3, held_until = now() + make_interval(secs => $4)
      WHERE event_id = $1 AND id = ANY($2::bigint[]) AND ${SEAT_IS_AVAILABLE}
      RETURNING id, section, row_label AS "row", number, price_cents AS "priceCents", held_until AS "heldUntil"`,
      [eventId, seatIds, userId, ttlSeconds]
    );
    return rows;
  }

  /** Seat details for ids kept outside Postgres (Redis holds), ordered by id. Unknown ids are skipped. */
  async findByIds(eventId: number, seatIds: number[], db: Queryable = this.database): Promise<Omit<HeldSeat, "heldUntil">[]> {
    const { rows } = await db.query<Omit<HeldSeat, "heldUntil">>(
      `SELECT id, section, row_label AS "row", number, price_cents AS "priceCents"
         FROM seats
        WHERE event_id = $1 AND id = ANY($2::bigint[])
        ORDER BY id`,
      [eventId, seatIds]
    );
    return rows;
  }

  /**
   * What a Redis hold needs from Postgres, in one round trip: the requested seats that are not sold,
   * and how many seats this buyer already bought in the event (paid or issued orders), the Postgres
   * half of the per-user limit. Each separate query would wait for a pool connection on its own.
   */
  async unsoldForHold(eventId: number, userId: number, seatIds: number[]): Promise<{ seats: Omit<HeldSeat, "heldUntil">[]; bought: number }> {
    const { rows } = await this.database.query<Omit<HeldSeat, "heldUntil"> & { bought: number }>(
      `SELECT b.bought, s.id, s.section, s.row_label AS "row", s.number, s.price_cents AS "priceCents"
         FROM (SELECT count(*)::int AS bought FROM order_items i JOIN orders o ON o.id = i.order_id
                WHERE o.event_id = $1 AND o.user_id = $2 AND o.status IN ('paid', 'issued')) b
         LEFT JOIN seats s ON s.event_id = $1 AND s.id = ANY($3::bigint[]) AND s.status <> 'sold'
        ORDER BY s.id`,
      [eventId, userId, seatIds]
    );
    // The LEFT JOIN keeps one row for the count even when no seat matches.
    const seats = rows.filter((row) => row.id !== null).map(({ bought: _bought, ...seat }) => seat);
    return { seats, bought: rows[0].bought };
  }

  /** The seats among `seatIds` that belong to an order awaiting payment: they must not be released. */
  async inPendingOrders(eventId: number, seatIds: number[], db: Queryable = this.database): Promise<number[]> {
    const { rows } = await db.query<{ id: number }>(
      `SELECT i.seat_id AS id FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.event_id = $1 AND o.status = 'pending_payment' AND i.seat_id = ANY($2::bigint[])`,
      [eventId, seatIds]
    );
    return rows.map((r) => Number(r.id));
  }

  /** Seats this user holds (unexpired) or has bought in the event: what the per-user limit counts. */
  async countUserSeats(eventId: number, userId: number, db: Queryable = this.database): Promise<number> {
    const { rows } = await db.query<{ count: number }>(
      `SELECT
       (SELECT count(*) FROM seats
         WHERE event_id = $1 AND held_by = $2 AND ${HOLD_IS_ACTIVE})
     + (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id
         WHERE o.event_id = $1 AND o.user_id = $2 AND o.status IN ('paid', 'issued'))
     AS count`,
      [eventId, userId]
    );
    return rows[0].count;
  }

  /** The buyer's active holds in the event, earliest expiry first. */
  async activeHoldsOf(eventId: number, userId: number, db: Queryable = this.database): Promise<HeldSeat[]> {
    const { rows } = await db.query<HeldSeat>(
      `SELECT id, section, row_label AS "row", number, price_cents AS "priceCents", held_until AS "heldUntil"
         FROM seats
        WHERE event_id = $1 AND held_by = $2 AND ${HOLD_IS_ACTIVE}
        ORDER BY held_until, id`,
      [eventId, userId]
    );
    return rows;
  }

  /**
   * Releases the buyer's holds (all of them, or only `seatIds`): the seats are available again
   * the moment this commits. Seats held by someone else are never touched. Returns the count.
   */
  async releaseHoldsOf(
    eventId: number,
    userId: number,
    seatIds: number[] | null,
    db: Queryable = this.database
  ): Promise<number> {
    const { rowCount } = await db.query(
      `UPDATE seats
          SET status = 'available', held_by = NULL, held_until = NULL
        WHERE event_id = $1 AND held_by = $2 AND status = 'held'
          AND ($3::bigint[] IS NULL OR id = ANY($3::bigint[]))
          AND ${NOT_IN_PENDING_ORDER}`,
      [eventId, userId, seatIds]
    );
    return rowCount ?? 0;
  }

  /**
   * Finds the seats among `seatIds` that this user holds (unexpired), locks them against every other
   * request until the transaction ends, and returns them with their price, ordered by id.
   * Fewer rows than requested means a seat is not held by this buyer anymore (never held, expired,
   * or taken by someone else). Meaningful only inside a transaction: the lock lasts until it ends.
   */
  async lockSeatsHeldByUser(
    eventId: number,
    userId: number,
    seatIds: number[],
    db: Queryable
  ): Promise<{ id: number; priceCents: number }[]> {
    const { rows } = await db.query<{ id: number; priceCents: number }>(
      `SELECT id, price_cents AS "priceCents" FROM seats
        WHERE event_id = $1 AND held_by = $2 AND id = ANY($3::bigint[]) AND ${HOLD_IS_ACTIVE}
        ORDER BY id
        FOR UPDATE`,
      [eventId, userId, seatIds]
    );
    return rows;
  }

  /** Gives the held seats a fresh expiry: a buyer who is paying must not lose the seats mid-payment. */
  async extendHolds(seatIds: number[], ttlSeconds: number, db: Queryable): Promise<void> {
    await db.query(
      `UPDATE seats SET held_until = now() + make_interval(secs => $2) WHERE id = ANY($1::bigint[]) AND status = 'held'`,
      [seatIds, ttlSeconds]
    );
  }

  /**
   * For holds kept in Redis, where the row only knows available / sold: locks the unsold seats among
   * `seatIds` until the transaction ends. Fewer rows than requested means a seat is already sold.
   */
  async lockUnsoldSeats(
    eventId: number,
    seatIds: number[],
    db: Queryable
  ): Promise<{ id: number; section: string; priceCents: number }[]> {
    const { rows } = await db.query<{ id: number; section: string; priceCents: number }>(
      `SELECT id, section, price_cents AS "priceCents" FROM seats
        WHERE event_id = $1 AND id = ANY($2::bigint[]) AND status = 'available'
        ORDER BY id
        FOR UPDATE`,
      [eventId, seatIds]
    );
    return rows;
  }

  /** The conditional sale for holds kept in Redis: a seat sold by anyone else does not match. */
  async sellUnsoldSeats(seatIds: number[], db: Queryable): Promise<number> {
    const { rowCount } = await db.query(
      "UPDATE seats SET status = 'sold' WHERE id = ANY($1::bigint[]) AND status = 'available'",
      [seatIds]
    );
    return rowCount ?? 0;
  }

  /**
   * Turns held seats into sold seats, but only if this buyer still holds them. The returned count
   * lets the caller prove every seat was really sold; fewer than expected means the hold was lost.
   */
  async sellHeldSeats(userId: number, seatIds: number[], db: Queryable): Promise<number> {
    const { rowCount } = await db.query(
      `UPDATE seats SET status = 'sold', held_by = NULL, held_until = NULL
        WHERE id = ANY($1::bigint[]) AND status = 'held' AND held_by = $2`,
      [seatIds, userId]
    );
    return rowCount ?? 0;
  }
}
