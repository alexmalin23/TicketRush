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

@Injectable()
export class SeatsModel {
  constructor(private readonly database: DatabaseService) {}

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
}
