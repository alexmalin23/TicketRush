import request from "supertest";
import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { RedisService } from "../../src/database/redis.service";
import { OrdersService } from "../../src/modules/orders/orders.service";
import { PaymentWorker } from "../../src/modules/orders/payment-worker";
import { buildScenario, holdRequest, Scenario } from "../helpers/scenario";
import { ProviderOverrides, startStack } from "../helpers/stack";
import { bearer, http } from "../helpers/test-app";

const API = "/api/v1";
const ASYNC = { ORDER_PROCESSING: "async", RECONCILE_INTERVAL_SECONDS: "0" };

describe("Async orders (e2e)", () => {
  let app: ModexApplication;
  let db: DatabaseService;
  let s: Scenario;
  let mockUrl: string;
  let stop: () => Promise<void>;

  const useStack = (provider: ProviderOverrides, withWorker = true, apiEnv: Record<string, string> = {}) => {
    beforeAll(async () => {
      const stack = await startStack(provider, { ...ASYNC, ...apiEnv });
      ({ app, stop } = stack);
      mockUrl = stack.mock.url;
      db = app.get(DatabaseService);
    });
    afterAll(() => stop());
    beforeEach(async () => {
      await app.get(RedisService).client.flushdb();
      s = await buildScenario(app, 6, 3);
      await request(mockUrl).delete("/ledger");
      if (withWorker) app.get(PaymentWorker).start();
    });
    if (withWorker) afterEach(() => app.get(PaymentWorker).onShutdown());
  };

  const placeOrder = async (key = "key-1") => {
    await holdRequest(app, s.eventId)(s.tokens[0], [s.seatIds[0]]).expect(201);
    const res = await http(app)
      .post(`${API}/orders`)
      .set(bearer(s.tokens[0]))
      .set("Idempotency-Key", key)
      .send({ eventId: s.eventId, seatIds: [s.seatIds[0]] })
      .expect(202);
    return res.body.id as string;
  };
  const statusOf = (id: string) => http(app).get(`${API}/orders/${id}`).set(bearer(s.tokens[0])).expect(200);
  const decided = async (id: string, within = 8000) => {
    const deadline = Date.now() + within;
    for (;;) {
      const { status } = (await statusOf(id)).body;
      if (status !== "pending_payment" || Date.now() > deadline) return status as string;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const ledger = async () => (await request(mockUrl).get("/ledger").expect(200)).body;
  const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0].n);

  describe("a successful charge", () => {
    useStack({});

    it("answers 202 pending at once, and the worker sells and issues", async () => {
      const id = await placeOrder();
      expect(await decided(id)).toBe("issued");
      expect(await count("SELECT count(*) AS n FROM tickets")).toBe(1);
      expect((await ledger()).charges).toHaveLength(1);
    });
  });

  describe("the same job", () => {
    useStack({ MOCK_PAYMENT_LATENCY_MS_MIN: "50", MOCK_PAYMENT_LATENCY_MS_MAX: "50" }, false);

    it("run ten times at once charges once and issues one ticket", async () => {
      const id = await placeOrder();
      const orders = app.get(OrdersService);

      await Promise.allSettled(Array.from({ length: 10 }, () => orders.processPayment(id)));

      expect((await ledger()).charges).toHaveLength(1);
      expect(await count("SELECT count(*) AS n FROM tickets")).toBe(1);
      expect((await statusOf(id)).body.status).toBe("issued");
    });

    it("run again after it finished changes nothing", async () => {
      const id = await placeOrder();
      const orders = app.get(OrdersService);
      await orders.processPayment(id);
      await orders.processPayment(id);

      expect(await count("SELECT count(*) AS n FROM payments")).toBe(1);
      expect(await count("SELECT count(*) AS n FROM tickets")).toBe(1);
    });
  });

  describe("a declined card", () => {
    useStack({ MOCK_PAYMENT_FAILURE_RATE: "1" });

    it("fails the order without a retry, and frees the seat", async () => {
      const id = await placeOrder();
      expect(await decided(id)).toBe("failed");
      expect(await count("SELECT count(*) AS n FROM payments")).toBe(1);
      const seat = await db.query<{ status: string }>("SELECT status FROM seats WHERE id = $1", [s.seatIds[0]]);
      expect(seat.rows[0].status).toBe("available");
    });
  });

  describe("a provider that never answers", () => {
    useStack({ MOCK_PAYMENT_TIMEOUT_RATE: "1", MOCK_PAYMENT_HANG_MS: "600" }, false, { PAYMENT_TIMEOUT_MS: "150" });

    it("throws so the queue retries, and keeps the seat: the charge may have happened", async () => {
      const id = await placeOrder();

      await expect(app.get(OrdersService).processPayment(id)).rejects.toThrow("timed out");

      expect((await statusOf(id)).body.status).toBe("pending_payment");
      const seat = await db.query<{ status: string }>("SELECT status FROM seats WHERE id = $1", [s.seatIds[0]]);
      expect(seat.rows[0].status).toBe("held");
    });
  });

  describe("a retry with the same key", () => {
    useStack({}, false);

    it("replays the same order and queues nothing new", async () => {
      const id = await placeOrder();
      const again = await http(app)
        .post(`${API}/orders`)
        .set(bearer(s.tokens[0]))
        .set("Idempotency-Key", "key-1")
        .send({ eventId: s.eventId, seatIds: [s.seatIds[0]] })
        .expect(202);
      expect(again.body.id).toBe(id);
      expect(await count("SELECT count(*) AS n FROM orders")).toBe(1);
    });
  });
});
