import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { createTestApp, createUser, resetDatabase } from "../helpers/test-app";

/** Invariants the database itself enforces, whatever the application code does. */
describe("Ticketing schema (e2e)", () => {
  let app: ModexApplication;
  let db: DatabaseService;
  let userId: number;
  let eventId: number;

  const insertSeat = async (number: number, extra = "") =>
    (
      await db.query<{ id: number }>(
        `INSERT INTO seats (event_id, section, row_label, number, price_cents${extra ? ", status, held_by, held_until" : ""})
         VALUES ($1, 'A', '1', $2, 5000${extra}) RETURNING id`,
        [eventId, number]
      )
    ).rows[0].id;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });
  beforeEach(async () => {
    await resetDatabase(app);
    userId = (await createUser(app, "buyer@example.com")).id;
    const venue = await db.query<{ id: number }>("INSERT INTO venues (name) VALUES ('Arena') RETURNING id");
    const event = await db.query<{ id: number }>(
      `INSERT INTO events (venue_id, name, starts_at, onsale_at)
       VALUES ($1, 'Big Concert', now() + interval '30 days', now()) RETURNING id`,
      [venue.rows[0].id]
    );
    eventId = event.rows[0].id;
  });
  afterAll(() => app.close());

  it("creates every table and drops the old catalog", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name <> 'schema_migrations' ORDER BY table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "events", "idempotency_keys", "order_items", "orders", "payments", "seats", "tickets", "users", "venues",
    ]);
  });

  it("a seat is held only together with a holder and an expiry", async () => {
    await expect(db.query(`UPDATE seats SET status = 'held' WHERE id = $1`, [await insertSeat(1)])).rejects.toMatchObject({
      code: "23514", // check_violation
    });
    await expect(insertSeat(2, `, 'held', ${userId}, now() + interval '10 minutes'`)).resolves.toBeDefined();
  });

  it("the same seat cannot exist twice in one event", async () => {
    await insertSeat(1);
    await expect(insertSeat(1)).rejects.toMatchObject({ code: "23505" }); // unique_violation
  });

  it("a seat can carry only one ticket, even if two orders reach it", async () => {
    const seatId = await insertSeat(1);
    const newOrder = async () =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO orders (user_id, event_id, status, total_cents) VALUES ($1, $2, 'paid', 5000) RETURNING id`,
          [userId, eventId]
        )
      ).rows[0].id;
    const issue = (orderId: string, code: string) =>
      db.query(`INSERT INTO tickets (order_id, event_id, seat_id, code) VALUES ($1, $2, $3, $4)`, [
        orderId, eventId, seatId, code,
      ]);

    await issue(await newOrder(), "code-1");
    await expect(issue(await newOrder(), "code-2")).rejects.toMatchObject({ code: "23505" });
  });
});
