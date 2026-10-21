import { Injectable } from "../../core";
import { Queryable } from "../../database/database.constants";
import { DatabaseService } from "../../database/database.service";

export type EventStatus = "draft" | "onsale" | "soldout" | "ended";

export interface EventSummary {
  id: number;
  name: string;
  startsAt: Date;
  onsaleAt: Date;
  status: EventStatus;
  venue: { id: number; name: string };
}

export interface EventDetail extends EventSummary {
  maxSeatsPerUser: number;
  waitingRoomEnabled: boolean;
}

const SUMMARY_COLUMNS = `
  e.id, e.name, e.starts_at AS "startsAt", e.onsale_at AS "onsaleAt", e.status,
  json_build_object('id', v.id, 'name', v.name) AS venue`;

@Injectable()
export class EventsModel {
  constructor(private readonly database: DatabaseService) {}

  async findAll(db: Queryable = this.database): Promise<EventSummary[]> {
    const { rows } = await db.query<EventSummary>(
      `SELECT ${SUMMARY_COLUMNS}
         FROM events e JOIN venues v ON v.id = e.venue_id
        ORDER BY e.starts_at, e.id`
    );
    return rows;
  }

  async findById(id: number, db: Queryable = this.database): Promise<EventDetail | null> {
    const { rows } = await db.query<EventDetail>(
      `SELECT ${SUMMARY_COLUMNS},
              e.max_seats_per_user AS "maxSeatsPerUser",
              e.waiting_room_enabled AS "waitingRoomEnabled"
         FROM events e JOIN venues v ON v.id = e.venue_id
        WHERE e.id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }
}
