import { ModexApplication } from "../../src/core";
import { buildScenario, holdRequest, Scenario } from "../helpers/scenario";
import { createTestApp } from "../helpers/test-app";

describe("Hold rate limit (e2e)", () => {
  let app: ModexApplication;
  let s: Scenario;
  let hold: ReturnType<typeof holdRequest>;
  const saved = { limit: process.env.HOLD_RATE_LIMIT, window: process.env.HOLD_RATE_WINDOW_SECONDS };

  beforeAll(async () => {
    // Read once at startup, so it is set before the app is built.
    process.env.HOLD_RATE_LIMIT = "3";
    process.env.HOLD_RATE_WINDOW_SECONDS = "1";
    app = await createTestApp();
  });
  afterAll(async () => {
    process.env.HOLD_RATE_LIMIT = saved.limit;
    process.env.HOLD_RATE_WINDOW_SECONDS = saved.window;
    await app.close();
  });
  beforeEach(async () => {
    // The limiter's memory outlives the database reset, and ids restart at 1: let the
    // previous test's window end before user 1 starts again.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    s = await buildScenario(app, 12, 2);
    hold = holdRequest(app, s.eventId);
  });

  it("answers 429 with Retry-After once a buyer exceeds the limit", async () => {
    for (const seatId of s.seatIds.slice(0, 3)) await hold(s.tokens[0], [seatId]).expect(201);

    const res = await hold(s.tokens[0], [s.seatIds[3]]).expect(429);
    expect(res.body).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSeconds: 1 } });
    expect(res.headers["retry-after"]).toBe("1");
  });

  it("counts every attempt, not only successful holds", async () => {
    await hold(s.tokens[1], [s.seatIds[0]]).expect(201);
    await hold(s.tokens[0], [s.seatIds[0]]).expect(409);
    await hold(s.tokens[0], [s.seatIds[0]]).expect(409);
    await hold(s.tokens[0], [s.seatIds[0]]).expect(409);

    await hold(s.tokens[0], [s.seatIds[1]]).expect(429);
  });

  it("limits each buyer separately", async () => {
    for (const seatId of s.seatIds.slice(0, 3)) await hold(s.tokens[0], [seatId]).expect(201);
    await hold(s.tokens[0], [s.seatIds[3]]).expect(429);

    await hold(s.tokens[1], [s.seatIds[4]]).expect(201);
  });

  it("opens a new window after the old one ends", async () => {
    for (const seatId of s.seatIds.slice(0, 3)) await hold(s.tokens[0], [seatId]).expect(201);
    await hold(s.tokens[0], [s.seatIds[3]]).expect(429);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await hold(s.tokens[0], [s.seatIds[3]]).expect(201);
  });
});
