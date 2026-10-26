import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { buildScenario, holdRequest, Scenario } from "../helpers/scenario";
import { bearer, createTestApp, http } from "../helpers/test-app";

const API = "/api/v1";
const BUYERS = 50;

describe("Holds (e2e)", () => {
  describe("POST /events/:id/holds", () => {
    let app: ModexApplication;
    let db: DatabaseService;
    let s: Scenario;
    let hold: ReturnType<typeof holdRequest>;

    beforeAll(async () => {
      app = await createTestApp();
      db = app.get(DatabaseService);
    });
    afterAll(() => app.close());
    beforeEach(async () => {
      s = await buildScenario(app, 12, BUYERS);
      hold = holdRequest(app, s.eventId);
    });

    const holderOf = async (seatId: number) =>
      (await db.query<{ status: string; held_by: number | null }>("SELECT status, held_by FROM seats WHERE id = $1", [seatId])).rows[0];

    it("holds free seats and returns them with an expiry", async () => {
      const res = await hold(s.tokens[0], [s.seatIds[0], s.seatIds[1]]).expect(201);
      expect(res.body.seats.map((seat: { id: number }) => seat.id).sort()).toEqual([s.seatIds[0], s.seatIds[1]].sort());
      expect(res.body.seats[0]).toEqual({ id: expect.any(Number), section: "A", row: "1", number: expect.any(Number), priceCents: 45000 });
      // The expiry is stamped by the database clock, the comparison uses the test process clock:
      // allow a few seconds of drift between the two instead of assuming they agree to the ms.
      const ttl = (new Date(res.body.expiresAt).getTime() - Date.now()) / 1000;
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThan(605);
    });

    it(`${BUYERS} concurrent buyers, one seat: exactly one success`, async () => {
      const results = await Promise.all(s.tokens.map((token) => hold(token, [s.seatIds[0]])));
      const winners = results.filter((r) => r.status === 201);
      const losers = results.filter((r) => r.status === 409 && r.body.code === "SEAT_UNAVAILABLE");

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(BUYERS - 1);
      // The database agrees with the one buyer who was told "yours".
      const winnerIndex = results.indexOf(winners[0]);
      expect((await holderOf(s.seatIds[0])).held_by).toBe(s.userIds[winnerIndex]);
    });

    it("all-or-nothing: one unavailable seat means nothing is held", async () => {
      await hold(s.tokens[0], [s.seatIds[1]]).expect(201);

      const res = await hold(s.tokens[1], [s.seatIds[0], s.seatIds[1], s.seatIds[2]]).expect(409);
      expect(res.body).toMatchObject({ code: "SEAT_UNAVAILABLE", details: { seatIds: [s.seatIds[1]] } });
      expect((await holderOf(s.seatIds[0])).status).toBe("available");
      expect((await holderOf(s.seatIds[2])).status).toBe("available");
    });

    it("overlapping requests in opposite order never deadlock and never split a pair", async () => {
      const [a, b] = s.seatIds;
      const results = await Promise.all(
        s.tokens.map((token, i) => hold(token, i % 2 === 0 ? [a, b] : [b, a]))
      );

      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true); // no 500 (deadlock)
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const [holderA, holderB] = [await holderOf(a), await holderOf(b)];
      expect(holderA.held_by).toBe(holderB.held_by); // both seats went to the same buyer
    });

    it("an expired hold can be taken by someone else", async () => {
      await db.query(
        "UPDATE seats SET status = 'held', held_by = $2, held_until = now() - interval '1 second' WHERE id = $1",
        [s.seatIds[0], s.userIds[0]]
      );
      await hold(s.tokens[1], [s.seatIds[0]]).expect(201);
      expect((await holderOf(s.seatIds[0])).held_by).toBe(s.userIds[1]);
    });

    it("repeated holds are additive and do not extend earlier ones", async () => {
      await hold(s.tokens[0], [s.seatIds[0]]).expect(201);
      const first = (await db.query<{ held_until: Date }>("SELECT held_until FROM seats WHERE id = $1", [s.seatIds[0]])).rows[0];
      await new Promise((resolve) => setTimeout(resolve, 20));
      await hold(s.tokens[0], [s.seatIds[1]]).expect(201);

      const after = (await db.query<{ held_until: Date }>("SELECT held_until FROM seats WHERE id = $1", [s.seatIds[0]])).rows[0];
      expect(after.held_until).toEqual(first.held_until);
      expect((await holderOf(s.seatIds[1])).held_by).toBe(s.userIds[0]);
    });

    it("per-user limit: 409 HOLD_LIMIT_EXCEEDED beyond max_seats_per_user", async () => {
      await hold(s.tokens[0], s.seatIds.slice(0, 5)).expect(201);

      const res = await hold(s.tokens[0], s.seatIds.slice(5, 7)).expect(409);
      expect(res.body).toMatchObject({ code: "HOLD_LIMIT_EXCEEDED", details: { limit: 6, owned: 5, requested: 2 } });
      expect((await holderOf(s.seatIds[5])).status).toBe("available");

      await hold(s.tokens[0], [s.seatIds[5]]).expect(201); // exactly at the limit is fine
    });

    it("per-user limit holds under concurrency: one buyer, six parallel requests of two seats", async () => {
      const pairs = [0, 2, 4, 6, 8, 10].map((i) => [s.seatIds[i], s.seatIds[i + 1]]);
      const results = await Promise.all(pairs.map((pair) => hold(s.tokens[0], pair)));

      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 409 && r.body.code === "HOLD_LIMIT_EXCEEDED")).toHaveLength(3);
      const owned = await db.query("SELECT 1 FROM seats WHERE held_by = $1 AND status = 'held'", [s.userIds[0]]);
      expect(owned.rowCount).toBe(6);
    });

    it("requires a login, valid input and an event that is on sale", async () => {
      await http(app).post(`${API}/events/${s.eventId}/holds`).send({ seatIds: [s.seatIds[0]] }).expect(401);
      expect((await hold(s.tokens[0], []).expect(400)).body.code).toBe("VALIDATION_ERROR");
      expect((await hold(s.tokens[0], [1, 2, 3, 4, 5, 6, 7]).expect(400)).body.code).toBe("VALIDATION_ERROR");
      await holdRequest(app, 999999)(s.tokens[0], [s.seatIds[0]]).expect(404);

      await db.query("UPDATE events SET status = 'draft' WHERE id = $1", [s.eventId]);
      expect((await hold(s.tokens[0], [s.seatIds[0]]).expect(409)).body.code).toBe("EVENT_NOT_ON_SALE");
    });
  });
  describe("GET and DELETE /events/:id/holds/me", () => {
    let app: ModexApplication;
    let db: DatabaseService;
    let s: Scenario;
    let hold: ReturnType<typeof holdRequest>;
    const mine = (token: string) => http(app).get(`${API}/events/${s.eventId}/holds/me`).set(bearer(token));
    const release = (token: string, body?: object) => {
      const req = http(app).delete(`${API}/events/${s.eventId}/holds/me`).set(bearer(token));
      return body ? req.send(body) : req;
    };
    const statusInMap = async (seatId: number) => {
      const res = await http(app).get(`${API}/events/${s.eventId}/seats?section=A`).expect(200);
      return res.body.seats.find((seat: { id: number }) => seat.id === seatId).status;
    };

    beforeAll(async () => {
      app = await createTestApp();
      db = app.get(DatabaseService);
    });
    afterAll(() => app.close());
    beforeEach(async () => {
      s = await buildScenario(app, 6, 2);
      hold = holdRequest(app, s.eventId);
    });

    it("lists only the buyer's active holds, each with its own expiry", async () => {
      await hold(s.tokens[0], [s.seatIds[0]]).expect(201);
      await hold(s.tokens[0], [s.seatIds[1]]).expect(201);
      await hold(s.tokens[1], [s.seatIds[2]]).expect(201); // someone else's
      await db.query(
        "UPDATE seats SET status = 'held', held_by = $2, held_until = now() - interval '1 second' WHERE id = $1",
        [s.seatIds[3], s.userIds[0]]
      ); // expired: no longer counts

      const res = await mine(s.tokens[0]).expect(200);
      expect(res.body.seats.map((seat: { id: number }) => seat.id)).toEqual([s.seatIds[0], s.seatIds[1]]);
      expect(res.body.seats[0]).toEqual({
        id: s.seatIds[0], section: "A", row: "1", number: 1, priceCents: 45000, expiresAt: expect.any(String),
      });
      expect(res.body.expiresAt).toBe(res.body.seats[0].expiresAt); // the next one to expire
    });

    it("returns an empty list and a null expiry when nothing is held", async () => {
      await mine(s.tokens[0]).expect(200, { seats: [], expiresAt: null });
    });

    it("releasing everything frees the seats immediately, for the map and for other buyers", async () => {
      await hold(s.tokens[0], [s.seatIds[0], s.seatIds[1]]).expect(201);
      expect(await statusInMap(s.seatIds[0])).toBe("unavailable");

      await release(s.tokens[0]).expect(204);

      expect(await statusInMap(s.seatIds[0])).toBe("available");
      expect(await statusInMap(s.seatIds[1])).toBe("available");
      await hold(s.tokens[1], [s.seatIds[0], s.seatIds[1]]).expect(201);
    });

    it("releases only the listed seats, and never another buyer's", async () => {
      await hold(s.tokens[0], [s.seatIds[0], s.seatIds[1]]).expect(201);
      await hold(s.tokens[1], [s.seatIds[2]]).expect(201);

      await release(s.tokens[0], { seatIds: [s.seatIds[0], s.seatIds[2]] }).expect(204);

      expect(await statusInMap(s.seatIds[0])).toBe("available");
      expect(await statusInMap(s.seatIds[1])).toBe("unavailable"); // not listed
      expect(await statusInMap(s.seatIds[2])).toBe("unavailable"); // buyer 1's seat
    });

    it("is idempotent: releasing twice, or nothing held, still answers 204", async () => {
      await hold(s.tokens[0], [s.seatIds[0]]).expect(201);
      await release(s.tokens[0]).expect(204);
      await release(s.tokens[0]).expect(204);
    });

    it("frees the per-buyer limit too", async () => {
      await hold(s.tokens[0], s.seatIds.slice(0, 6)).expect(201);
      await release(s.tokens[0], { seatIds: [s.seatIds[5]] }).expect(204);
      await hold(s.tokens[0], [s.seatIds[5]]).expect(201);
    });

    it("requires a login, a known event and valid input", async () => {
      await http(app).get(`${API}/events/${s.eventId}/holds/me`).expect(401);
      await http(app).delete(`${API}/events/${s.eventId}/holds/me`).expect(401);
      await http(app).get(`${API}/events/999999/holds/me`).set(bearer(s.tokens[0])).expect(404);
      expect((await release(s.tokens[0], { seatIds: [] }).expect(400)).body.code).toBe("VALIDATION_ERROR");
    });
  });
});
