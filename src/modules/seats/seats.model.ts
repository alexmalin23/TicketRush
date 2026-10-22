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
         WHERE event_id = $1 AND status = 'held' AND held_by = $2 AND held_until > now())
     + (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id
         WHERE o.event_id = $1 AND o.user_id = $2 AND o.status IN ('paid', 'issued'))
     AS count`,
      [eventId, userId]
    );
    return rows[0].count;
  }
}
