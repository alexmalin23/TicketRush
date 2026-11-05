import { Pool, PoolClient } from "pg";
import { loadDotEnvFile } from "../config/env";
import { hashPassword } from "../modules/auth/password";
import { Queryable } from "./database.constants";

/**
 * The "Big Concert" on-sale scenario: 1 venue, 1 event on sale now, 10,000 seats
 * (sections A-J x 40 rows x 25 seats) and N load-test users.
 *
 *   npm run db:seed              create or restore the scenario (safe to run again)
 *   SEED_USERS=5000 npm run db:seed
 *   npm run db:reset             only reset the event (between load runs)
 *   npm run db:seed -- large     add a 500,000-seat event, whose availability query is slow for real
 */
export const SCENARIO = {
  venue: "Arena",
  event: "Big Concert",
  sections: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
  rows: 40,
  seatsPerRow: 25,
  userPassword: "password123",
};

const LARGE_SCENARIO = { ...SCENARIO, venue: "Stadium", event: "Stadium Tour", rows: 200, seatsPerRow: 250 };

/**
 * Puts one event back to its on-sale starting point: no orders, payments or tickets,
 * every seat available. Pass a transaction client so it is all-or-nothing.
 * Returns the number of seats, or null if the event does not exist.
 */
export async function resetEvent(db: Queryable, eventId: number): Promise<number | null> {
  const event = await db.query("UPDATE events SET status = 'onsale' WHERE id = $1", [eventId]);
  if (event.rowCount === 0) return null;

  // Children first: order_items, payments and tickets reference orders.
  const orders = "SELECT id FROM orders WHERE event_id = $1";
  await db.query(`DELETE FROM tickets WHERE event_id = $1`, [eventId]);
  await db.query(`DELETE FROM payments WHERE order_id IN (${orders})`, [eventId]);
  await db.query(`DELETE FROM order_items WHERE order_id IN (${orders})`, [eventId]);
  await db.query(`DELETE FROM orders WHERE event_id = $1`, [eventId]);

  const seats = await db.query(
    `UPDATE seats SET status = 'available', held_by = NULL, held_until = NULL, version = 0
      WHERE event_id = $1`,
    [eventId]
  );
  return seats.rowCount ?? 0;
}

/**
 * One INSERT ... SELECT per table: Postgres generates the rows itself, so 30,000 rows
 * cost a few round trips instead of 30,000.
 */
async function createEvent(db: Queryable, scenario = SCENARIO): Promise<number> {
  const venue = await db.query<{ id: number }>("INSERT INTO venues (name) VALUES ($1) RETURNING id", [
    scenario.venue,
  ]);
  const event = await db.query<{ id: number }>(
    `INSERT INTO events (venue_id, name, starts_at, onsale_at, status)
     VALUES ($1, $2, now() + interval '30 days', now(), 'onsale') RETURNING id`,
    [venue.rows[0].id, scenario.event]
  );
  const eventId = event.rows[0].id;

  // Price by section: front sections cost more.
  await db.query(
    `INSERT INTO seats (event_id, section, row_label, number, price_cents)
     SELECT $1, section, row_number::text, seat_number,
            CASE WHEN section IN ('A', 'B') THEN 45000
                 WHEN section IN ('C', 'D', 'E', 'F') THEN 28000
                 ELSE 15000 END
       FROM unnest($2::text[]) AS section,
            generate_series(1, $3::int) AS row_number,
            generate_series(1, $4::int) AS seat_number`,
    [eventId, scenario.sections, scenario.rows, scenario.seatsPerRow]
  );
  return eventId;
}

async function findEventId(db: Queryable, name = SCENARIO.event): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>("SELECT id FROM events WHERE name = $1 ORDER BY id LIMIT 1", [
    name,
  ]);
  return rows[0]?.id ?? null;
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seed(pool: Pool, userCount: number): Promise<void> {
  // scrypt is deliberately slow (~50 ms). Hashing once and reusing it for every load-test
  // user keeps seeding fast; a shared salt is acceptable only for throwaway test accounts.
  const passwordHash = await hashPassword(SCENARIO.userPassword);
  const users = await pool.query(
    `INSERT INTO users (email, password_hash)
     SELECT 'user' || n || '@test.local', $1 FROM generate_series(1, $2::int) AS n
     ON CONFLICT (email) DO NOTHING`,
    [passwordHash, userCount]
  );
  console.log(`Users: ${users.rowCount} created (user1..user${userCount}@test.local / ${SCENARIO.userPassword})`);

  const { eventId, seats } = await inTransaction(pool, async (client) => {
    const id = (await findEventId(client)) ?? (await createEvent(client));
    return { eventId: id, seats: await resetEvent(client, id) };
  });
  console.log(`Event ${eventId} "${SCENARIO.event}": on sale, ${seats} seats available`);
}

async function seedLarge(pool: Pool): Promise<void> {
  const eventId = await inTransaction(
    pool,
    async (client) => (await findEventId(client, LARGE_SCENARIO.event)) ?? (await createEvent(client, LARGE_SCENARIO))
  );
  console.log(`Event ${eventId} "${LARGE_SCENARIO.event}": on sale`);
}

async function reset(pool: Pool): Promise<void> {
  const eventId = await findEventId(pool);
  if (eventId === null) throw new Error(`Event "${SCENARIO.event}" not found, run db:seed first`);
  const seats = await inTransaction(pool, (client) => resetEvent(client, eventId));
  console.log(`Event ${eventId} reset: ${seats} seats available`);
}

// `npm run db:seed` / `npm run db:reset` run this file directly.
if (require.main === module) {
  loadDotEnvFile();
  const userCount = Number(process.env.SEED_USERS ?? 20_000);
  if (!Number.isInteger(userCount) || userCount < 0) {
    console.error("SEED_USERS must be a non-negative integer");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const started = Date.now();
  const tasks: Record<string, () => Promise<void>> = { reset: () => reset(pool), large: () => seedLarge(pool) };
  const task = (tasks[process.argv[2]] ?? (() => seed(pool, userCount)))();
  task
    .then(() => console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
