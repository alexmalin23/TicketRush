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
          AND ($3::bigint[] IS NULL OR id = ANY($3::bigint[]))`,
      [eventId, userId, seatIds]
    );
    return rowCount ?? 0;
  }
}
