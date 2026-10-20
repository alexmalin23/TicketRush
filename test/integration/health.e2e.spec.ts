import { ModexApplication } from "../../src/core";
import { RedisService } from "../../src/database/redis.service";
import { createTestApp, http } from "../helpers/test-app";

describe("Health (e2e)", () => {
  let app: ModexApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it("/health answers without checking dependencies", async () => {
    await http(app).get("/health").expect(200, { status: "ok" });
  });

  it("/ready reports every dependency up", async () => {
    await http(app)
      .get("/ready")
      .expect(200, { status: "ready", checks: { postgres: "up", redis: "up" } });
  });

  it("/ready answers 503 fast while Redis is unreachable, and recovers", async () => {
    const redis = app.get(RedisService).client;
    redis.disconnect(); // a real lost connection, not a mock

    const started = Date.now();
    const res = await http(app).get("/ready").expect(503);
    expect(res.body.details).toEqual({ postgres: "up", redis: "down" });
    expect(Date.now() - started).toBeLessThan(1000); // no offline queue: fails immediately

    await redis.connect();
    await http(app).get("/ready").expect(200);
  });
});
