import { randomBytes } from "node:crypto";
import { Injectable } from "../../core";
import { Queryable } from "../../database/database.constants";
import { DatabaseService } from "../../database/database.service";

export interface Ticket {
  id: string;
  seatId: number;
  section: string;
  row: string;
  number: number;
  code: string;
}

/** An unguessable token for the QR code: 128 random bits, URL-safe. */
const newTicketCode = () => randomBytes(16).toString("base64url");

@Injectable()
export class TicketsModel {
  constructor(private readonly database: DatabaseService) {}

  /**
   * One ticket per seat. tickets.seat_id is UNIQUE: if the hold/sale logic ever let two orders reach
   * the same seat, the second insert fails and its transaction rolls back instead of selling twice.
   */
  async issueForSeats(orderId: string, eventId: number, seatIds: number[], db: Queryable = this.database): Promise<void> {
    await db.query(
      `INSERT INTO tickets (order_id, event_id, seat_id, code)
       SELECT $1, $2, seat_id, code FROM unnest($3::bigint[], $4::text[]) AS t(seat_id, code)`,
      [orderId, eventId, seatIds, seatIds.map(newTicketCode)]
    );
  }

  async findByOrder(orderId: string, db: Queryable = this.database): Promise<Ticket[]> {
    const { rows } = await db.query<Ticket>(
      `SELECT t.id, t.seat_id AS "seatId", s.section, s.row_label AS "row", s.number, t.code
         FROM tickets t JOIN seats s ON s.id = t.seat_id
        WHERE t.order_id = $1
        ORDER BY s.section, s.row_label, s.number`,
      [orderId]
    );
    return rows;
  }
}
