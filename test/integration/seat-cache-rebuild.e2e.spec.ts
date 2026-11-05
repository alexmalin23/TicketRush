import { ModexApplication } from "../../src/core";
import { RedisService } from "../../src/database/redis.service";
import { REBUILD_LOCK_TTL_MS, REBUILD_WAIT_MS, SeatCache, seatCacheKeys } from "../../src/modules/events/seat-cache";
import { SeatView, SectionAvailability } from "../../src/modules/seats/seats.model";
import { createTestApp } from "../helpers/test-app";

const EVENT = 1;
const ROWS: SectionAvailability[] = [{ name: "A", available: 1, total: 2 }];
const SEATS = [{ id: 1, section: "A", status: "available" }] as unknown as SeatView[];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Seat cache rebuild (e2e)", () => {
  const originalEnv = { ...process.env };
  const lock = seatCacheKeys.rebuild(EVENT, "counts");
  let app: ModexApplication;
  let cache: SeatCache;
  let redis: RedisService;

  /** Stands in for the slow query: counts its calls, and takes long enough for requests to pile up. */
  const slowLoad = <T>(result: T, ms = 50) => {
    const load = jest.fn(async () => {
      await sleep(ms);
      return result;
    });
    return load;
  };

  beforeEach(async () => {
    Object.assign(process.env, { CACHE_ENABLED: "true", AVAILABILITY_CACHE_TTL_MS: "60000", AVAILABILITY_STALE_MS: "60000" });
    app = await createTestApp();
    cache = app.get(SeatCache);
    redis = app.get(RedisService);
    await redis.client.flushdb();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
    process.env = { ...originalEnv };
  });

  it("requests that miss together run the query once and share its answer", async () => {
    const load = slowLoad(ROWS);

    const answers = await Promise.all(Array.from({ length: 20 }, () => cache.availability(EVENT, load)));

    expect(load).toHaveBeenCalledTimes(1);
    for (const answer of answers) expect(answer).toEqual(ROWS);
  });

  it("does the same for the seat map", async () => {
    const load = slowLoad(SEATS);

    const answers = await Promise.all(Array.from({ length: 20 }, () => cache.seatMap(EVENT, "A", load)));

    expect(load).toHaveBeenCalledTimes(1);
    for (const answer of answers) expect(answer).toHaveLength(1);
  });

  it("one section's rebuild does not make another section wait", async () => {
    const [loadA, loadB] = [slowLoad(SEATS), slowLoad(SEATS)];

    await Promise.all([
      ...Array.from({ length: 10 }, () => cache.seatMap(EVENT, "A", loadA)),
      ...Array.from({ length: 10 }, () => cache.seatMap(EVENT, "B", loadB)),
    ]);

    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(1);
  });

  it("holds the lock with a TTL during the rebuild and gives it back after", async () => {
    let ttlDuringRebuild = -2;
    const load = jest.fn(async () => {
      ttlDuringRebuild = await redis.client.pttl(lock);
      return ROWS;
    });

    await cache.availability(EVENT, load);

    expect(ttlDuringRebuild).toBeGreaterThan(0);
    expect(ttlDuringRebuild).toBeLessThanOrEqual(REBUILD_LOCK_TTL_MS);
    expect(await redis.client.exists(lock)).toBe(0);
  });

  it("does not release a lock that expired and now belongs to another request", async () => {
    let held = false;
    const load = jest.fn(async () => {
      held = (await redis.client.exists(lock)) === 1;
      await redis.client.set(lock, "the-next-holder", "PX", 60_000); // as if ours expired mid-rebuild
      return ROWS;
    });

    await cache.availability(EVENT, load);

    expect(held).toBe(true);
    expect(await redis.client.get(lock)).toBe("the-next-holder");
  });

  it("runs no query when the entry appeared just before the request got the lock", async () => {
    const load = slowLoad(ROWS);
    const set = redis.client.set.bind(redis.client) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(redis.client, "set").mockImplementationOnce((async (...args: unknown[]) => {
      await redis.client.hset(seatCacheKeys.counts(EVENT), "A", "1/2"); // the previous holder finishes here
      return set(...args);
    }) as never);

    expect(await cache.availability(EVENT, load)).toEqual(ROWS);
    expect(load).not.toHaveBeenCalled();
  });

  it("stops waiting for a holder that died, and answers anyway", async () => {
    await redis.client.set(lock, "dead-process", "PX", 60_000);
    const load = slowLoad(ROWS, 0);
    const started = Date.now();

    expect(await cache.availability(EVENT, load)).toEqual(ROWS);

    expect(load).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(REBUILD_WAIT_MS);
    expect(Date.now() - started).toBeLessThan(REBUILD_WAIT_MS + 500);
  });

  it("a failed query reaches its caller and frees the lock for the next request", async () => {
    await expect(cache.availability(EVENT, () => Promise.reject(new Error("database down")))).rejects.toThrow("database down");
    expect(await redis.client.exists(lock)).toBe(0);

    const started = Date.now();
    expect(await cache.availability(EVENT, slowLoad(ROWS, 0))).toEqual(ROWS);
    expect(Date.now() - started).toBeLessThan(REBUILD_WAIT_MS);
  });

  it("waiters take over at once when the holder leaves no entry", async () => {
    const load = slowLoad<SeatView[]>([], 10); // an unknown section: nothing to store
    const started = Date.now();

    const answers = await Promise.all(Array.from({ length: 5 }, () => cache.seatMap(EVENT, "Z", load)));

    for (const answer of answers) expect(answer).toEqual([]);
    expect(Date.now() - started).toBeLessThan(REBUILD_WAIT_MS);
  });

  it("serves a stale entry at once while one request refreshes it", async () => {
    await cache.availability(EVENT, async () => ROWS);
    await redis.client.del(seatCacheKeys.fresh(EVENT, "counts"));
    const newRows = [{ name: "A", available: 0, total: 2 }];
    const load = slowLoad(newRows);

    const answers = await Promise.all(Array.from({ length: 20 }, () => cache.availability(EVENT, load)));

    for (const answer of answers) expect(answer).toEqual(ROWS);
    await sleep(100);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.availability(EVENT, load)).toEqual(newRows);
  });

  it("a failed refresh leaves the stale answer and frees the lock", async () => {
    await cache.availability(EVENT, async () => ROWS);
    await redis.client.del(seatCacheKeys.fresh(EVENT, "counts"));

    expect(await cache.availability(EVENT, () => Promise.reject(new Error("database down")))).toEqual(ROWS);

    await sleep(20);
    expect(await redis.client.exists(lock)).toBe(0);
  });

  it("entries written together do not all expire together", async () => {
    const ttls = new Set<number>();
    for (let event = 100; event < 120; event++) {
      await cache.availability(event, async () => ROWS);
      ttls.add(Math.round((await redis.client.pttl(seatCacheKeys.fresh(event, "counts"))) / 100));
    }
    expect(ttls.size).toBeGreaterThan(1);
  });

  it("answers without Redis", async () => {
    const closed = new Promise((resolve) => redis.client.once("end", resolve));
    redis.client.disconnect();
    await closed;
    const load = slowLoad(ROWS, 0);

    expect(await cache.availability(EVENT, load)).toEqual(ROWS);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
