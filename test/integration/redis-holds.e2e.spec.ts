import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { RedisService } from "../../src/database/redis.service";
import { holdKeys } from "../../src/modules/holds/redis-hold-store";
import { buildScenario, holdRequest, Scenario } from "../helpers/scenario";
import { bearer, createTestApp, http } from "../helpers/test-app";

const API = "/api/v1";
const BUYERS = 50;

/** One API instance with holds in Redis; settings are read once at startup, so they are set first. */
async function startInstance(env: Record<string, string> = {}): Promise<ModexApplication> {
  const saved = { ...process.env };
  Object.assign(process.env, { HOLD_STORE: "redis", ...env });
  try {
    return await createTestApp();
  } finally {
    process.env = saved;
  }
}

describe("Holds in Redis (e2e)", () => {
  let app: ModexApplication;
  let db: DatabaseService;
  let s: Scenario;
  let hold: ReturnType<typeof holdRequest>;
  const owner = (seatId: number) => app.get(RedisService).client.get(holdKeys.seat(s.eventId, seatId));
  const myHolds = (token: string) => http(app).get(`${API}/events/${s.eventId}/holds/me`).set(bearer(token));

  beforeAll(async () => {
    app = await startInstance();
    db = app.get(DatabaseService);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await app.get(RedisService).client.flushdb(); // the test keyspace (db 1) only
    s = await buildScenario(app, 12, BUYERS);
    hold = holdRequest(app, s.eventId);
  });

  it("holds free seats in Redis, with an expiry, and leaves the seat rows untouched", async () => {
    const res = await hold(s.tokens[0], [s.seatIds[1], s.seatIds[0]]).expect(201);
    expect(res.body.seats.map((seat: { id: number }) => seat.id)).toEqual([s.seatIds[0], s.seatIds[1]]);
    expect(res.body.seats[0]).toEqual({ id: s.seatIds[0], section: "A", row: "1", number: 1, priceCents: 45000 });
    const ttl = (new Date(res.body.expiresAt).getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThan(605);

    expect(await owner(s.seatIds[0])).toBe(String(s.userIds[0]));
    const rows = await db.query("SELECT status FROM seats WHERE id = ANY($1::bigint[])", [[s.seatIds[0], s.seatIds[1]]]);
    expect(rows.rows.every((row) => row.status === "available")).toBe(true);
  });

  it(`${BUYERS} concurrent buyers, one seat: exactly one success`, async () => {
    const results = await Promise.all(s.tokens.map((token) => hold(token, [s.seatIds[0]])));
    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status === 409 && r.body.code === "SEAT_UNAVAILABLE");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(BUYERS - 1);
    expect(await owner(s.seatIds[0])).toBe(String(s.userIds[results.indexOf(winners[0])]));
  });

  it("all-or-nothing: one unavailable seat means nothing is held", async () => {
    await hold(s.tokens[0], [s.seatIds[1]]).expect(201);

    const res = await hold(s.tokens[1], [s.seatIds[0], s.seatIds[1], s.seatIds[2]]).expect(409);
    expect(res.body).toMatchObject({ code: "SEAT_UNAVAILABLE", details: { seatIds: [s.seatIds[1]] } });
    expect(await owner(s.seatIds[0])).toBeNull();
    expect(await owner(s.seatIds[2])).toBeNull();
  });

  it("all-or-nothing under concurrency: overlapping requests never split the seats", async () => {
    // Every buyer wants the same three seats, listed in a different order.
    const wanted = [s.seatIds[0], s.seatIds[1], s.seatIds[2]];
    const results = await Promise.all(s.tokens.map((token, i) => hold(token, i % 2 ? [...wanted].reverse() : wanted)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const owners = await Promise.all(wanted.map(owner));
    expect(new Set(owners).size).toBe(1);
  });

  it("refuses a sold seat or an unknown seat", async () => {
    await db.query("UPDATE seats SET status = 'sold' WHERE id = $1", [s.seatIds[0]]);

    const res = await hold(s.tokens[0], [s.seatIds[0], 999999]).expect(409);
    expect(res.body).toMatchObject({ code: "SEAT_UNAVAILABLE", details: { seatIds: [s.seatIds[0], 999999] } });
  });

  it("per-buyer limit: 409 HOLD_LIMIT_EXCEEDED beyond max_seats_per_user", async () => {
    await hold(s.tokens[0], s.seatIds.slice(0, 5)).expect(201);

    const res = await hold(s.tokens[0], s.seatIds.slice(5, 7)).expect(409);
    expect(res.body).toMatchObject({ code: "HOLD_LIMIT_EXCEEDED", details: { limit: 6, owned: 5, requested: 2 } });
    expect(await owner(s.seatIds[5])).toBeNull();
  });

  it("per-buyer limit counts seats already bought (in Postgres)", async () => {
    const order = await db.query<{ id: string }>(
      "INSERT INTO orders (user_id, event_id, status, total_cents) VALUES ($1, $2, 'issued', 180000) RETURNING id",
      [s.userIds[0], s.eventId]
    );
    await db.query(
      "INSERT INTO order_items (order_id, seat_id, price_cents) SELECT $1, unnest($2::bigint[]), 45000",
      [order.rows[0].id, s.seatIds.slice(8, 12)]
    );
    await db.query("UPDATE seats SET status = 'sold' WHERE id = ANY($1::bigint[])", [s.seatIds.slice(8, 12)]);

    await hold(s.tokens[0], s.seatIds.slice(0, 2)).expect(201);
    const res = await hold(s.tokens[0], [s.seatIds[2]]).expect(409);
    expect(res.body).toMatchObject({ code: "HOLD_LIMIT_EXCEEDED", details: { owned: 6 } });
  });

  it("per-buyer limit under concurrency: one buyer, six parallel requests of two seats", async () => {
    const pairs = [0, 2, 4, 6, 8, 10].map((i) => [s.seatIds[i], s.seatIds[i + 1]]);
    const results = await Promise.all(pairs.map((pair) => hold(s.tokens[0], pair)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const held = (await myHolds(s.tokens[0]).expect(200)).body.seats;
    expect(held).toHaveLength(6);
  });

  it("repeated holds add seats and never extend earlier ones", async () => {
    await hold(s.tokens[0], [s.seatIds[0]]).expect(201);
    const first = (await myHolds(s.tokens[0])).body.seats[0].expiresAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await hold(s.tokens[0], [s.seatIds[1]]).expect(201);

    const seats = (await myHolds(s.tokens[0]).expect(200)).body.seats;
    expect(seats.map((seat: { id: number }) => seat.id)).toEqual([s.seatIds[0], s.seatIds[1]]);
    expect(seats[0].expiresAt).toBe(first);
    expect(seats[1].expiresAt > first).toBe(true);
  });

  it("the seat map and availability show held seats as taken, and free again on release", async () => {
    await hold(s.tokens[0], [s.seatIds[0], s.seatIds[1]]).expect(201);
    const map = async () => (await http(app).get(`${API}/events/${s.eventId}/seats?section=A`).expect(200)).body.seats;
    const available = async () => (await http(app).get(`${API}/events/${s.eventId}/availability`).expect(200)).body.sections[0].available;

    expect((await map()).filter((seat: { status: string }) => seat.status === "unavailable")).toHaveLength(2);
    expect(await available()).toBe(10);

    await http(app).delete(`${API}/events/${s.eventId}/holds/me`).set(bearer(s.tokens[0])).send({ seatIds: [s.seatIds[0]] }).expect(204);
    expect(await available()).toBe(11);
    expect(await owner(s.seatIds[0])).toBeNull();
    await hold(s.tokens[1], [s.seatIds[0]]).expect(201);
  });

  it("release never touches another buyer's hold", async () => {
    await hold(s.tokens[0], [s.seatIds[0]]).expect(201);
    await http(app).delete(`${API}/events/${s.eventId}/holds/me`).set(bearer(s.tokens[1])).send({ seatIds: [s.seatIds[0]] }).expect(204);
    expect(await owner(s.seatIds[0])).toBe(String(s.userIds[0]));
  });

  it("a seat in an order awaiting payment cannot be released", async () => {
    await hold(s.tokens[0], [s.seatIds[0]]).expect(201);
    const order = await db.query<{ id: string }>(
      "INSERT INTO orders (user_id, event_id, status, total_cents) VALUES ($1, $2, 'pending_payment', 45000) RETURNING id",
      [s.userIds[0], s.eventId]
    );
    await db.query("INSERT INTO order_items (order_id, seat_id, price_cents) VALUES ($1, $2, 45000)", [order.rows[0].id, s.seatIds[0]]);

    await http(app).delete(`${API}/events/${s.eventId}/holds/me`).set(bearer(s.tokens[0])).send({}).expect(204);
    expect(await owner(s.seatIds[0])).toBe(String(s.userIds[0]));
  });
});

describe("Holds in Redis: event reset (e2e)", () => {
  it("the dev reset frees seats held in Redis", async () => {
    const app = await startInstance({ ENABLE_DEV_ROUTES: "true" });
    try {
      await app.get(RedisService).client.flushdb();
      const s = await buildScenario(app, 2, 2);
      await holdRequest(app, s.eventId)(s.tokens[0], [s.seatIds[0]]).expect(201);

      await http(app).post(`${API}/dev/events/${s.eventId}/reset`).expect(200);
      expect(await app.get(RedisService).client.exists(holdKeys.seat(s.eventId, s.seatIds[0]))).toBe(0);
      await holdRequest(app, s.eventId)(s.tokens[1], [s.seatIds[0]]).expect(201);
    } finally {
      await app.close();
    }
  });
});

describe("Holds in Redis: expiry (e2e)", () => {
  it("an expired hold frees the seat with no cleanup: Redis deletes the key", async () => {
    const app = await startInstance({ HOLD_TTL_SECONDS: "1" });
    try {
      await app.get(RedisService).client.flushdb();
      const s = await buildScenario(app, 2, 2);
      const hold = holdRequest(app, s.eventId);
      await hold(s.tokens[0], [s.seatIds[0]]).expect(201);
      await hold(s.tokens[1], [s.seatIds[0]]).expect(409);

      await new Promise((resolve) => setTimeout(resolve, 1200));
      await hold(s.tokens[1], [s.seatIds[0]]).expect(201);
      const mine = await http(app).get(`${API}/events/${s.eventId}/holds/me`).set(bearer(s.tokens[0])).expect(200);
      expect(mine.body.seats).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
