import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { RedisService } from "../../src/database/redis.service";
import { eventCacheKey } from "../../src/modules/events/events.service";
import { SeatCache, seatCacheKeys } from "../../src/modules/events/seat-cache";
import { buildScenario, holdRequest, Scenario } from "../helpers/scenario";
import { createTestApp, http } from "../helpers/test-app";

const API = "/api/v1";

describe("Event cache (e2e)", () => {
  const originalEnv = { ...process.env };
  let app: ModexApplication;
  let db: DatabaseService;
  let redis: RedisService;
  let s: Scenario;

  const start = async (env: Record<string, string> = {}) => {
    Object.assign(process.env, { CACHE_ENABLED: "true", ENABLE_DEV_ROUTES: "true" }, env);
    app = await createTestApp();
    db = app.get(DatabaseService);
    redis = app.get(RedisService);
    await redis.client.flushdb();
    s = await buildScenario(app, 3, 2);
  };
  const rename = (name: string) => db.query("UPDATE events SET name = $1 WHERE id = $2", [name, s.eventId]);
  const getEvent = () => http(app).get(`${API}/events/${s.eventId}`).expect(200);

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
  });

  it("serves the second read from Redis, with the same answer and a TTL", async () => {
    await start({ EVENT_CACHE_TTL_SECONDS: "120" });
    const first = await getEvent();

    await rename("Changed in Postgres");
    const second = await getEvent();

    expect(second.body).toEqual(first.body);
    const ttl = await redis.client.ttl(eventCacheKey(s.eventId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("reads Postgres again once the entry is gone", async () => {
    await start();
    await getEvent();
    await rename("Changed in Postgres");
    await redis.client.del(eventCacheKey(s.eventId));

    expect((await getEvent()).body.name).toBe("Changed in Postgres");
  });

  it("does not store an event that does not exist", async () => {
    await start();
    await http(app).get(`${API}/events/999999`).expect(404);
    expect(await redis.client.exists(eventCacheKey(999999))).toBe(0);
  });

  it("the hold check reads Postgres: a stale cache can neither close nor open the sale", async () => {
    await start();
    const hold = holdRequest(app, s.eventId);

    await getEvent(); // cached as onsale
    await db.query("UPDATE events SET status = 'draft' WHERE id = $1", [s.eventId]);
    expect((await hold(s.tokens[0], [s.seatIds[0]]).expect(409)).body.code).toBe("EVENT_NOT_ON_SALE");

    await redis.client.del(eventCacheKey(s.eventId));
    await getEvent(); // cached as draft
    await db.query("UPDATE events SET status = 'onsale' WHERE id = $1", [s.eventId]);
    await hold(s.tokens[0], [s.seatIds[0]]).expect(201);
  });

  it("resetting the event clears its entry", async () => {
    await start();
    await getEvent();
    await http(app).post(`${API}/dev/events/${s.eventId}/reset`).expect(200);
    expect(await redis.client.exists(eventCacheKey(s.eventId))).toBe(0);
  });

  it("keeps answering from Postgres when Redis is down", async () => {
    await start();
    redis.client.disconnect();
    expect((await getEvent()).body.name).toBe("Big Concert");
  });

  it("stays out of Redis when CACHE_ENABLED=false", async () => {
    await start({ CACHE_ENABLED: "false" });
    await getEvent();
    expect(await redis.client.exists(eventCacheKey(s.eventId))).toBe(0);
  });

  describe.each(["postgres", "redis"])("availability and seat map, holds in %s", (store) => {
    const availability = () => http(app).get(`${API}/events/${s.eventId}/availability`).expect(200);
    const seatMap = () => http(app).get(`${API}/events/${s.eventId}/seats?section=A`).expect(200);
    const statuses = (res: { body: { seats: { status: string }[] } }) => res.body.seats.map((seat) => seat.status);
    const startCached = (ttlMs: number, staleMs = 0) =>
      start({ HOLD_STORE: store, AVAILABILITY_CACHE_TTL_MS: String(ttlMs), AVAILABILITY_STALE_MS: String(staleMs) });
    const expire = () => new Promise((resolve) => setTimeout(resolve, 60));

    it("answers exactly like the hold store, on a miss and on a hit", async () => {
      await startCached(60_000);
      await holdRequest(app, s.eventId)(s.tokens[0], [s.seatIds[1]]).expect(201);

      const first = [await availability(), await seatMap()];
      const second = [await availability(), await seatMap()];

      expect(second[0].body).toEqual(first[0].body);
      expect(second[1].body).toEqual(first[1].body);
      expect(first[0].body.sections).toEqual([{ name: "A", available: 2, total: 3 }]);
      expect(statuses(first[1])).toEqual(["available", "unavailable", "available"]);
    });

    it("a buyer who sees a taken seat as free is still refused by the hold", async () => {
      await startCached(60_000);
      const hold = holdRequest(app, s.eventId);
      await seatMap(); // cached with every seat free
      const freeKey = seatCacheKeys.free(s.eventId, "A");
      const everySeatFree = await redis.client.getBuffer(freeKey);
      await hold(s.tokens[0], [s.seatIds[0]]).expect(201);
      // A rebuild that read before the hold can write after its invalidation.
      await redis.client.set(freeKey, everySeatFree!, "PX", 60_000);
      await redis.client.set(seatCacheKeys.fresh(s.eventId, "A"), "1", "PX", 60_000);

      expect(statuses(await seatMap())[0]).toBe("available");
      expect((await hold(s.tokens[1], [s.seatIds[0]]).expect(409)).body.code).toBe("SEAT_UNAVAILABLE");
    });

    it("shows the real state once the entry expires", async () => {
      await startCached(50);
      await seatMap();
      await availability();
      await holdRequest(app, s.eventId)(s.tokens[0], [s.seatIds[0]]).expect(201);

      await expire();

      expect(statuses(await seatMap())[0]).toBe("unavailable");
      expect((await availability()).body.sections[0].available).toBe(2);
    });

    it("the buyer sees their hold and their release at once, whatever the TTL", async () => {
      await startCached(60_000, 60_000);
      await seatMap();
      await availability();

      await holdRequest(app, s.eventId)(s.tokens[0], [s.seatIds[0]]).expect(201);
      expect(statuses(await seatMap())[0]).toBe("unavailable");
      expect((await availability()).body.sections[0].available).toBe(2);

      await http(app)
        .delete(`${API}/events/${s.eventId}/holds/me`)
        .set("Authorization", `Bearer ${s.tokens[0]}`)
        .expect(204);
      expect(statuses(await seatMap())[0]).toBe("available");
      expect((await availability()).body.sections[0].available).toBe(3);
    });

    it("a rebuild that read before a hold and wrote after its invalidation lasts only until the bound", async () => {
      await startCached(100, 100);
      const cache = app.get(SeatCache);
      let finishQuery = () => {};
      const staleRead = [{ name: "A", available: 3, total: 3 }];
      const rebuild = cache.availability(s.eventId, async () => {
        await new Promise<void>((resolve) => (finishQuery = resolve)); // read before the hold, not yet written
        return staleRead;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      await holdRequest(app, s.eventId)(s.tokens[0], [s.seatIds[0]]).expect(201);
      finishQuery();
      await rebuild;

      expect((await availability()).body.sections[0].available).toBe(3); // the race: the old state is back
      await new Promise((resolve) => setTimeout(resolve, 230)); // 1.1 x TTL + stale window
      await availability(); // may still be the last stale answer, while it refreshes
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await availability()).body.sections[0].available).toBe(2);
    });

    it("does not store a section that does not exist", async () => {
      await startCached(60_000);
      await http(app).get(`${API}/events/${s.eventId}/seats?section=Z`).expect(404);
      expect(await redis.client.keys("*:Z")).toEqual([]);
    });

    it("every key expires, and resetting the event clears them", async () => {
      await startCached(60_000);
      await availability();
      await seatMap();
      const keys = (await redis.client.keys(`*:{${s.eventId}}:*`)).filter((key) => /availability|section-(layout|free)/.test(key));
      expect(keys).toHaveLength(3);
      for (const key of keys) expect(await redis.client.pttl(key)).toBeGreaterThan(0);

      await http(app).post(`${API}/dev/events/${s.eventId}/reset`).expect(200);
      expect(await redis.client.exists(...keys)).toBe(0);
    });
  });

  it("availability and seat map keep answering from Postgres when Redis is down", async () => {
    await start();
    redis.client.disconnect();
    expect((await http(app).get(`${API}/events/${s.eventId}/availability`).expect(200)).body.sections[0].total).toBe(3);
    expect((await http(app).get(`${API}/events/${s.eventId}/seats?section=A`).expect(200)).body.seats).toHaveLength(3);
  });
});
