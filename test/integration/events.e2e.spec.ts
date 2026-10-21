import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { createTestApp, createUser, http, resetDatabase } from "../helpers/test-app";

const API = "/api/v1";

describe("Events & seat map (e2e)", () => {
  let app: ModexApplication;
  let db: DatabaseService;
  let eventId: number;
  let venueId: number;
  const seat: Record<string, number> = {};

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    await resetDatabase(app);
    const { id: holder } = await createUser(app, "holder@example.com");
    venueId = (await db.query<{ id: number }>("INSERT INTO venues (name) VALUES ('Arena') RETURNING id")).rows[0].id;
    eventId = (
      await db.query<{ id: number }>(
        `INSERT INTO events (venue_id, name, starts_at, onsale_at, status)
         VALUES ($1, 'Big Concert', '2026-12-01T20:00:00Z', '2026-11-01T10:00:00Z', 'onsale') RETURNING id`,
        [venueId]
      )
    ).rows[0].id;

    // Section A: one seat in each state. Row "10" is inserted before row "2" on purpose.
    const insert = async (key: string, section: string, row: string, n: number, price: number, extra = "", values: unknown[] = []) =>
      (seat[key] = (
        await db.query<{ id: number }>(
          `INSERT INTO seats (event_id, section, row_label, number, price_cents${extra ? ", status, held_by, held_until" : ""})
           VALUES ($1, $2, $3, $4, $5${extra}) RETURNING id`,
          [eventId, section, row, n, price, ...values]
        )
      ).rows[0].id);
    await insert("free", "A", "10", 1, 45000);
    await insert("heldActive", "A", "2", 1, 45000, ", 'held', $6, now() + interval '10 minutes'", [holder]);
    await insert("heldExpired", "A", "2", 2, 45000, ", 'held', $6, now() - interval '1 second'", [holder]);
    await db.query(
      `INSERT INTO seats (event_id, section, row_label, number, price_cents, status) VALUES ($1, 'A', '2', 3, 45000, 'sold')`,
      [eventId]
    );
    await insert("b", "B", "1", 1, 15000);
  });

  it("GET /events lists events with their venue", async () => {
    const res = await http(app).get(`${API}/events`).expect(200);
    expect(res.body).toEqual([
      {
        id: eventId,
        name: "Big Concert",
        startsAt: "2026-12-01T20:00:00.000Z",
        onsaleAt: "2026-11-01T10:00:00.000Z",
        status: "onsale",
        venue: { id: venueId, name: "Arena" },
      },
    ]);
  });

  it("GET /events/:id adds limits and section prices; 404 unknown, 400 invalid id", async () => {
    const res = await http(app).get(`${API}/events/${eventId}`).expect(200);
    expect(res.body).toMatchObject({
      id: eventId,
      maxSeatsPerUser: 6,
      waitingRoomEnabled: false,
      sections: [
        { name: "A", priceCents: 45000 },
        { name: "B", priceCents: 15000 },
      ],
    });
    expect((await http(app).get(`${API}/events/999999`).expect(404)).body.code).toBe("NOT_FOUND");
    expect((await http(app).get(`${API}/events/abc`).expect(400)).body.code).toBe("VALIDATION_ERROR");
  });

  it("an expired hold counts as available in the summary", async () => {
    await http(app)
      .get(`${API}/events/${eventId}/availability`)
      .expect(200, {
        sections: [
          { name: "A", available: 2, total: 4 }, // free + expired hold
          { name: "B", available: 1, total: 1 },
        ],
      });
  });

  it("an expired hold is available in the seat map; active holds and sold seats are not", async () => {
    const res = await http(app).get(`${API}/events/${eventId}/seats?section=A`).expect(200);
    expect(res.body.section).toBe("A");

    const statusOf = Object.fromEntries(res.body.seats.map((s: { id: number; status: string }) => [s.id, s.status]));
    expect(statusOf[seat.free]).toBe("available");
    expect(statusOf[seat.heldExpired]).toBe("available");
    expect(statusOf[seat.heldActive]).toBe("unavailable");
    expect(res.body.seats.filter((s: { status: string }) => s.status === "unavailable")).toHaveLength(2); // + sold
  });

  it("the seat map never reveals holders and sorts rows naturally", async () => {
    const res = await http(app).get(`${API}/events/${eventId}/seats?section=A`).expect(200);
    for (const s of res.body.seats) {
      expect(Object.keys(s).sort()).toEqual(["id", "number", "priceCents", "row", "status"]);
    }
    expect(res.body.seats.map((s: { row: string; number: number }) => `${s.row}-${s.number}`)).toEqual([
      "2-1", "2-2", "2-3", "10-1",
    ]);
  });

  it("the seat map requires a known section", async () => {
    expect((await http(app).get(`${API}/events/${eventId}/seats`).expect(400)).body.code).toBe("VALIDATION_ERROR");
    expect((await http(app).get(`${API}/events/${eventId}/seats?section=Z`).expect(404)).body.code).toBe("NOT_FOUND");
  });
});
