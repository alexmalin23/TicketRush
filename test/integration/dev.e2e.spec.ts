import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { createTestApp, createUser, http, resetDatabase } from "../helpers/test-app";

describe("Dev routes (e2e)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("with ENABLE_DEV_ROUTES=true", () => {
    let app: ModexApplication;
    let db: DatabaseService;
    const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0].n);

    beforeAll(async () => {
      process.env.ENABLE_DEV_ROUTES = "true";
      app = await createTestApp();
      db = app.get(DatabaseService);
    });
    afterAll(() => app.close());

    it("puts a sold-out event back to its on-sale starting point", async () => {
      await resetDatabase(app);
      const { id: userId } = await createUser(app, "buyer@example.com");
      const q = <T extends object>(sql: string, values: unknown[] = []) =>
        db.query<T & { id: number }>(sql, values).then((r) => r.rows[0]);

      // A dirty event: one seat held, one sold (order + payment + ticket), status soldout.
      const venue = await q("INSERT INTO venues (name) VALUES ('Arena') RETURNING id");
      const event = await q(
        `INSERT INTO events (venue_id, name, starts_at, onsale_at, status)
         VALUES ($1, 'Big Concert', now() + interval '1 day', now(), 'soldout') RETURNING id`,
        [venue.id]
      );
      await db.query(
        `INSERT INTO seats (event_id, section, row_label, number, price_cents, status, held_by, held_until)
         VALUES ($1, 'A', '1', 1, 5000, 'held', $2, now() + interval '10 minutes')`,
        [event.id, userId]
      );
      const sold = await q(
        `INSERT INTO seats (event_id, section, row_label, number, price_cents, status)
         VALUES ($1, 'A', '1', 2, 5000, 'sold') RETURNING id`,
        [event.id]
      );
      const order = await q(
        `INSERT INTO orders (user_id, event_id, status, total_cents) VALUES ($1, $2, 'issued', 5000) RETURNING id`,
        [userId, event.id]
      );
      await db.query(`INSERT INTO order_items VALUES ($1, $2, 5000)`, [order.id, sold.id]);
      await db.query(`INSERT INTO payments (order_id, attempt, status) VALUES ($1, 1, 'succeeded')`, [order.id]);
      await db.query(`INSERT INTO tickets (order_id, event_id, seat_id, code) VALUES ($1, $2, $3, 'qr')`, [
        order.id, event.id, sold.id,
      ]);

      await http(app)
        .post(`/api/v1/dev/events/${event.id}/reset`)
        .expect(200, { eventId: event.id, seatsAvailable: 2 });

      expect(await count("SELECT count(*) AS n FROM seats WHERE status <> 'available' OR held_by IS NOT NULL")).toBe(0);
      for (const table of ["orders", "order_items", "payments", "tickets"]) {
        expect(await count(`SELECT count(*) AS n FROM ${table}`)).toBe(0);
      }
      expect((await q<{ status: string }>("SELECT status FROM events WHERE id = $1", [event.id])).status).toBe("onsale");
      expect(await count("SELECT count(*) AS n FROM users")).toBe(1); // users are not part of the reset
    });

    it("returns 404 for an unknown event", async () => {
      await http(app).post("/api/v1/dev/events/999999/reset").expect(404);
    });
  });

  it("is indistinguishable from an unknown route when disabled", async () => {
    process.env.ENABLE_DEV_ROUTES = "false";
    const app = await createTestApp();
    const res = await http(app).post("/api/v1/dev/events/1/reset").expect(404);
    expect(res.body.message).toBe("Cannot POST /api/v1/dev/events/1/reset");
    await app.close();
  });
});
