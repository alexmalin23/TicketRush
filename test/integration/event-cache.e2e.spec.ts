import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { RedisService } from "../../src/database/redis.service";
import { eventCacheKey } from "../../src/modules/events/events.service";
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
    s = await buildScenario(app, 3, 1);
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
});
