import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { DUMMY_HASH } from "../../src/modules/auth/password";
import { TokenService } from "../../src/modules/auth/token.service";
import { bearer, http, resetDatabase } from "./test-app";

const API = "/api/v1";

export interface Scenario {
  eventId: number;
  seatIds: number[];
  tokens: string[];
  userIds: number[];
}

/** One on-sale event with `seats` seats in section A and `buyers` users with signed tokens. */
export async function buildScenario(app: ModexApplication, seats: number, buyers: number): Promise<Scenario> {
  await resetDatabase(app);
  const db = app.get(DatabaseService);
  // Buyers inserted directly and signed locally: N logins would only measure scrypt.
  const users = await db.query<{ id: number; email: string }>(
    `INSERT INTO users (email, password_hash)
     SELECT 'buyer' || n || '@test.local', $1 FROM generate_series(1, $2::int) n RETURNING id, email`,
    [DUMMY_HASH, buyers]
  );
  const signer = app.get(TokenService);
  const venue = await db.query<{ id: number }>("INSERT INTO venues (name) VALUES ('Arena') RETURNING id");
  const eventId = (
    await db.query<{ id: number }>(
      `INSERT INTO events (venue_id, name, starts_at, onsale_at, status)
       VALUES ($1, 'Big Concert', now() + interval '30 days', now() - interval '1 minute', 'onsale') RETURNING id`,
      [venue.rows[0].id]
    )
  ).rows[0].id;
  const seatIds = (
    await db.query<{ id: number }>(
      `INSERT INTO seats (event_id, section, row_label, number, price_cents)
       SELECT $1, 'A', '1', n, 45000 FROM generate_series(1, $2::int) n ORDER BY n RETURNING id`,
      [eventId, seats]
    )
  ).rows.map((r) => r.id);
  return {
    eventId,
    seatIds,
    userIds: users.rows.map((u) => u.id),
    tokens: users.rows.map((u) => signer.sign({ id: u.id, email: u.email, role: "user" })),
  };
}

export const holdRequest = (app: ModexApplication, eventId: number) => (token: string, ids: number[]) =>
  http(app).post(`${API}/events/${eventId}/holds`).set(bearer(token)).send({ seatIds: ids });

