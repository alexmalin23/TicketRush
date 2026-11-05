import request from "supertest";
import { appDefinition } from "../../src/app";
import { ExpressFactory, ModexApplication } from "../../src/core";
import { RedisService } from "../../src/database/redis.service";
import { MetricsService } from "../../src/modules/metrics/metrics.service";
import { buildScenario, Scenario } from "../helpers/scenario";

describe("Metrics (e2e)", () => {
  const originalEnv = { ...process.env };
  let app: ModexApplication;
  let s: Scenario;

  beforeEach(async () => {
    process.env.CACHE_ENABLED = "true";
    app = await ExpressFactory.create(appDefinition);
    app.use(app.get(MetricsService).middleware);
    await app.init();
    await app.get(RedisService).client.flushdb();
    s = await buildScenario(app, 2, 1);
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
  });

  const scrape = async () => (await request(app.getExpressApp()).get("/metrics").expect(200)).text;

  it("labels requests by route, not by id, and leaves itself out", async () => {
    const api = request(app.getExpressApp());
    await api.get(`/api/v1/events/${s.eventId}`).expect(200);
    await api.get("/nothing-here").expect(404);
    const text = await scrape();

    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*route="[^"]*\/events\/:id"[^}]*status="200"/);
    expect(text).toMatch(/route="unmatched"/);
    expect(text).not.toContain(`/events/${s.eventId}"`);
    expect(await scrape()).not.toContain('route="/metrics"');
  });

  it("counts seat cache misses and hits", async () => {
    const api = request(app.getExpressApp());
    await api.get(`/api/v1/events/${s.eventId}/availability`).expect(200);
    await api.get(`/api/v1/events/${s.eventId}/availability`).expect(200);
    const text = await scrape();
    expect(text).toContain('seat_cache_requests_total{result="miss"} 1');
    expect(text).toContain('seat_cache_requests_total{result="fresh"} 1');
  });

  it("reports the pool", async () => {
    expect(await scrape()).toMatch(/db_pool_connections\{state="waiting"\} 0/);
  });
});
