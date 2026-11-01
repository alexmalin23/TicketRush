import { ModexApplication } from "../../src/core";
import { buildScenario, holdRequest, Scenario } from "../helpers/scenario";
import { createTestApp } from "../helpers/test-app";

const LIMIT = 3;
const STORES = ["redis", "memory"] as const;

/** Builds one API instance; settings are read once at startup, so they are set first. */
async function startInstance(store: (typeof STORES)[number]): Promise<ModexApplication> {
  const saved = { ...process.env };
  process.env.HOLD_RATE_LIMIT = String(LIMIT);
  process.env.HOLD_RATE_WINDOW_SECONDS = "1";
  process.env.RATE_LIMIT_STORE = store;
  try {
    return await createTestApp();
  } finally {
    process.env = saved;
  }
}

// Both stores keep their counts past the database reset, and user ids restart at 1:
// let the previous test's window end before user 1 starts again.
const windowEnds = () => new Promise((resolve) => setTimeout(resolve, 1100));

describe.each(STORES)("Hold rate limit, %s store (e2e)", (store) => {
  let app: ModexApplication;
  let s: Scenario;
  let hold: ReturnType<typeof holdRequest>;

  beforeAll(async () => {
    app = await startInstance(store);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await windowEnds();
    s = await buildScenario(app, 12, 2);
    hold = holdRequest(app, s.eventId);
  });

  it("answers 429 with Retry-After once a buyer exceeds the limit", async () => {
    for (const seatId of s.seatIds.slice(0, LIMIT)) await hold(s.tokens[0], [seatId]).expect(201);

    const res = await hold(s.tokens[0], [s.seatIds[3]]).expect(429);
    expect(res.body).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSeconds: 1 } });
    expect(res.headers["retry-after"]).toBe("1");
  });

  it("counts every attempt, not only successful holds", async () => {
    await hold(s.tokens[1], [s.seatIds[0]]).expect(201);
    for (let i = 0; i < LIMIT; i++) await hold(s.tokens[0], [s.seatIds[0]]).expect(409);

    await hold(s.tokens[0], [s.seatIds[1]]).expect(429);
  });

  it("limits each buyer separately", async () => {
    for (const seatId of s.seatIds.slice(0, LIMIT)) await hold(s.tokens[0], [seatId]).expect(201);
    await hold(s.tokens[0], [s.seatIds[3]]).expect(429);

    await hold(s.tokens[1], [s.seatIds[4]]).expect(201);
  });

  it("allows attempts again once the window has passed", async () => {
    for (const seatId of s.seatIds.slice(0, LIMIT)) await hold(s.tokens[0], [seatId]).expect(201);
    await hold(s.tokens[0], [s.seatIds[3]]).expect(429);

    await windowEnds();
    await hold(s.tokens[0], [s.seatIds[3]]).expect(201);
  });
});

describe("Hold rate limit across two instances (e2e)", () => {
  // Two real API instances in one process: separate containers, pools and memory, one Redis.
  const allowedAcross = async (store: (typeof STORES)[number], parallel: boolean) => {
    const [a, b] = [await startInstance(store), await startInstance(store)];
    try {
      await windowEnds();
      const s = await buildScenario(a, 12, 1);
      const attempt = (i: number) => holdRequest(i % 2 ? b : a, s.eventId)(s.tokens[0], [s.seatIds[0]]);
      const attempts = Array.from({ length: 10 }, (_, i) => i);
      const results = parallel
        ? await Promise.all(attempts.map((i) => attempt(i).then((res) => res)))
        : await attempts.reduce<Promise<{ status: number }[]>>(async (done, i) => [...(await done), await attempt(i)], Promise.resolve([]));
      return results.filter((r) => r.status !== 429).length;
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  };

  it("redis: the limit holds exactly for the whole system, alternating instances", async () => {
    expect(await allowedAcross("redis", false)).toBe(LIMIT);
  });

  it("redis: the limit holds exactly under simultaneous attempts on both instances", async () => {
    expect(await allowedAcross("redis", true)).toBe(LIMIT);
  });

  it("memory (benchmark baseline): each instance counts alone, so the limit doubles", async () => {
    expect(await allowedAcross("memory", false)).toBe(LIMIT * 2);
  });
});
