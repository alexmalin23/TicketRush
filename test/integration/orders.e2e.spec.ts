import request from "supertest";
import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { RedisService } from "../../src/database/redis.service";
import { holdKeys } from "../../src/modules/holds/redis-hold-store";
import { OrdersModel } from "../../src/modules/orders/orders.model";
import { OrdersService } from "../../src/modules/orders/orders.service";
import { buildScenario, holdRequest, Scenario } from "../helpers/scenario";
import { ProviderOverrides, startStack } from "../helpers/stack";
import { bearer, createTestApp, http } from "../helpers/test-app";

const API = "/api/v1";

describe("Orders (e2e)", () => {
  let app: ModexApplication;
  let db: DatabaseService;
  let s: Scenario;
  let mockUrl: string;
  let stop: () => Promise<void>;

  const useStack = (provider: ProviderOverrides, apiEnv: Record<string, string> = {}, providerUrl?: string) => {
    beforeAll(async () => {
      const stack = await startStack(provider, apiEnv, providerUrl);
      ({ app, stop } = stack);
      mockUrl = stack.mock.url;
      db = app.get(DatabaseService);
    });
    afterAll(() => stop());
    beforeEach(async () => {
      await app.get(RedisService).client.flushdb(); // the test keyspace (db 1) only; event ids repeat
      s = await buildScenario(app, 12, 20);
      await request(mockUrl).delete("/ledger");
    });
  };

  const hold = (userIndex: number, ids: number[]) => holdRequest(app, s.eventId)(s.tokens[userIndex], ids);
  const order = (userIndex: number, key: string | undefined, body: object) => {
    const req = http(app).post(`${API}/orders`).set(bearer(s.tokens[userIndex]));
    return (key === undefined ? req : req.set("Idempotency-Key", key)).send(body);
  };
  const ledger = async () => (await request(mockUrl).get("/ledger").expect(200)).body;
  const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0].n);
  const seatState = async (id: number) =>
    (await db.query<{ status: string; held_by: number | null }>("SELECT status, held_by FROM seats WHERE id = $1", [id])).rows[0];
  const redisOwner = (seatId: number) => app.get(RedisService).client.get(holdKeys.seat(s.eventId, seatId));
  const payments = async () =>
    (await db.query<{ status: string }>("SELECT status FROM payments ORDER BY attempt")).rows.map((p) => p.status);

  describe("payment succeeds", () => {
    useStack({});

    it("creates a paid order, sells the seats and charges exactly the total", async () => {
      await hold(0, [s.seatIds[0], s.seatIds[1]]).expect(201);

      const res = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[1], s.seatIds[0]] }).expect(201);

      expect(res.body).toMatchObject({ status: "issued", totalCents: 90000, eventId: s.eventId });
      expect(res.body.items.map((i: { seatId: number }) => i.seatId)).toEqual([s.seatIds[0], s.seatIds[1]]);
      expect(await seatState(s.seatIds[0])).toEqual({ status: "sold", held_by: null });
      expect((await ledger()).totals).toEqual({ charges: 1, succeeded: 1, declined: 0, capturedCents: 90000 });
      expect(await payments()).toEqual(["succeeded"]);
    });

    it("a retry with the same key replays the answer: no second order, no second charge", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const body = { eventId: s.eventId, seatIds: [s.seatIds[0]] };

      const first = await order(0, "k1", body).expect(201);
      const retry = await order(0, "k1", body).expect(201);

      expect(retry.body).toEqual(first.body);
      expect(await count("SELECT count(*) AS n FROM orders")).toBe(1);
      expect((await ledger()).totals.charges).toBe(1);
    });

    it("the same key with another body is 422 IDEMPOTENCY_KEY_REUSED", async () => {
      await hold(0, [s.seatIds[0], s.seatIds[1]]).expect(201);
      await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0]] }).expect(201);
      const res = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[1]] }).expect(422);
      expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("refuses seats the buyer does not hold: never held, someone else's, or expired", async () => {
      await hold(1, [s.seatIds[1]]).expect(201); // someone else's
      await hold(0, [s.seatIds[2]]).expect(201);
      await db.query("UPDATE seats SET held_until = now() - interval '1 second' WHERE id = $1", [s.seatIds[2]]); // expired

      const res = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0], s.seatIds[1], s.seatIds[2]] }).expect(409);
      expect(res.body).toMatchObject({ code: "HOLD_INVALID", details: { seatIds: [s.seatIds[0], s.seatIds[1], s.seatIds[2]] } });
      expect((await ledger()).totals.charges).toBe(0);
      expect(await count("SELECT count(*) AS n FROM orders")).toBe(0);
    });

    it("the same buyer double-clicking with 8 parallel requests: one order, one charge", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const body = { eventId: s.eventId, seatIds: [s.seatIds[0]] };

      const results = await Promise.all(Array.from({ length: 8 }, () => order(0, "same-key", body)));

      const statuses = results.map((r) => r.status);
      expect(statuses.filter((st) => st === 201).length).toBeGreaterThanOrEqual(1);
      expect(statuses.every((st) => st === 201 || st === 409)).toBe(true); // 409 = still in progress
      expect(await count("SELECT count(*) AS n FROM orders")).toBe(1);
      expect((await ledger()).totals.charges).toBe(1);
    });

    it("parallel orders with different keys for the same seats: one order, one charge", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const body = { eventId: s.eventId, seatIds: [s.seatIds[0]] };

      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => order(0, `key-${i}`, body)));

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
      expect(await count("SELECT count(*) AS n FROM orders WHERE status = 'issued'")).toBe(1);
      expect((await ledger()).totals.charges).toBe(1);
    });

    it("issues one ticket per seat with a unique unguessable code, readable only by the buyer", async () => {
      await hold(0, [s.seatIds[0], s.seatIds[1]]).expect(201);
      const created = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0], s.seatIds[1]] }).expect(201);

      const res = await http(app).get(`${API}/orders/${created.body.id}/tickets`).set(bearer(s.tokens[0])).expect(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toEqual({
        id: expect.any(String), seatId: s.seatIds[0], section: "A", row: "1", number: 1, code: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      });
      expect(new Set(res.body.map((t: { code: string }) => t.code)).size).toBe(2);

      await http(app).get(`${API}/orders/${created.body.id}/tickets`).set(bearer(s.tokens[1])).expect(404);
      await http(app).get(`${API}/orders/${created.body.id}/tickets`).expect(401);
    });

    it("a replayed order does not issue more tickets", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const body = { eventId: s.eventId, seatIds: [s.seatIds[0]] };
      await order(0, "k1", body).expect(201);
      await order(0, "k1", body).expect(201);
      expect(await count("SELECT count(*) AS n FROM tickets")).toBe(1);
    });

    it("if issuing fails after the charge, nothing is half done and the charge stays visible", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      // A ticket for this seat already exists (the last line of defense against a double sale).
      const other = await db.query<{ id: string }>(
        "INSERT INTO orders (user_id, event_id, status, total_cents) VALUES ($1, $2, 'issued', 45000) RETURNING id",
        [s.userIds[1], s.eventId]
      );
      await db.query("INSERT INTO tickets (order_id, event_id, seat_id, code) VALUES ($1, $2, $3, 'pre-existing')", [
        other.rows[0].id, s.eventId, s.seatIds[0],
      ]);

      const res = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0]] });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await seatState(s.seatIds[0])).status).toBe("held"); // not sold: the whole sale rolled back
      expect(await count("SELECT count(*) AS n FROM tickets")).toBe(1); // only the pre-existing one
      expect((await db.query("SELECT status FROM orders WHERE user_id = $1", [s.userIds[0]])).rows).toEqual([{ status: "pending_payment" }]);
      expect((await ledger()).totals.succeeded).toBe(1); // charged, so a reconciliation can find it
      const invariants = await http(app).get(`${API}/dev/events/${s.eventId}/invariants`).expect(200);
      expect(invariants.body.awaitingReconciliation).toBe(1);
    });

    it("lists and shows only my own orders; someone else's order is a 404", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const created = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0]] }).expect(201);

      const mine = await http(app).get(`${API}/orders`).set(bearer(s.tokens[0])).expect(200);
      expect(mine.body.map((o: { id: string }) => o.id)).toEqual([created.body.id]);
      await http(app).get(`${API}/orders`).set(bearer(s.tokens[1])).expect(200, []);

      await http(app).get(`${API}/orders/${created.body.id}`).set(bearer(s.tokens[0])).expect(200);
      await http(app).get(`${API}/orders/${created.body.id}`).set(bearer(s.tokens[1])).expect(404);
    });

    it("requires a login, an Idempotency-Key and valid input", async () => {
      await http(app).post(`${API}/orders`).set("Idempotency-Key", "k").send({ eventId: s.eventId, seatIds: [1] }).expect(401);
      const noKey = await order(0, undefined, { eventId: s.eventId, seatIds: [s.seatIds[0]] }).expect(400);
      expect(noKey.body.code).toBe("VALIDATION_ERROR");
      expect((await order(0, "k", { eventId: s.eventId, seatIds: [] }).expect(400)).body.code).toBe("VALIDATION_ERROR");
      await http(app).get(`${API}/orders/not-a-uuid`).set(bearer(s.tokens[0])).expect(400);
      await order(0, "k", { eventId: 999999, seatIds: [s.seatIds[0]] }).expect(404);
    });
  });

  describe("payment is declined", () => {
    useStack({ MOCK_PAYMENT_FAILURE_RATE: "1" });

    it("fails the order with 402 and frees the seats at once", async () => {
      await hold(0, [s.seatIds[0], s.seatIds[1]]).expect(201);

      const res = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0], s.seatIds[1]] }).expect(402);

      expect(res.body.code).toBe("PAYMENT_DECLINED");
      const failed = await http(app).get(`${API}/orders/${res.body.details.orderId}`).set(bearer(s.tokens[0])).expect(200);
      expect(failed.body.status).toBe("failed");
      expect(await seatState(s.seatIds[0])).toEqual({ status: "available", held_by: null });
      await hold(1, [s.seatIds[0], s.seatIds[1]]).expect(201); // someone else can buy them now
      expect((await ledger()).totals).toMatchObject({ charges: 1, declined: 1, capturedCents: 0 });
    });

    it("a retry of a declined order with the same key is 402 again, without charging again", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const body = { eventId: s.eventId, seatIds: [s.seatIds[0]] };
      await order(0, "k1", body).expect(402);
      await order(0, "k1", body).expect(402);
      expect((await ledger()).totals.charges).toBe(1);
      expect(await count("SELECT count(*) AS n FROM orders")).toBe(1);
    });
  });

  describe("the provider answers too slowly", () => {
    // Every charge takes 2 s, the API waits 100 ms per attempt: all 3 attempts time out.
    useStack({ MOCK_PAYMENT_LATENCY_MS_MIN: "2000", MOCK_PAYMENT_LATENCY_MS_MAX: "2000" }, { PAYMENT_TIMEOUT_MS: "100" });

    it("answers 202, keeps the order pending with its seats held, and never charges twice", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const body = { eventId: s.eventId, seatIds: [s.seatIds[0]] };

      const res = await order(0, "k1", body).expect(202);
      expect(res.body.status).toBe("pending_payment");
      expect(await payments()).toEqual(["timeout", "timeout", "timeout"]);
      expect((await seatState(s.seatIds[0])).status).toBe("held");

      // A new key must not create a second order (and a second charge) for the same seats.
      const again = await order(0, "k2", body).expect(409);
      expect(again.body).toMatchObject({ code: "ORDER_IN_PROGRESS", details: { orderId: res.body.id } });

      // Releasing the seats mid-payment is refused silently: the seats stay committed to the payment.
      await http(app).delete(`${API}/events/${s.eventId}/holds/me`).set(bearer(s.tokens[0])).expect(204);
      expect((await seatState(s.seatIds[0])).status).toBe("held");

      const early = await http(app).get(`${API}/orders/${res.body.id}/tickets`).set(bearer(s.tokens[0])).expect(409);
      expect(early.body).toMatchObject({ code: "ORDER_NOT_ISSUED", details: { status: "pending_payment" } });

      await new Promise((resolve) => setTimeout(resolve, 2100)); // the provider finishes in the background
      expect((await ledger()).totals).toMatchObject({ charges: 1, succeeded: 1 });
    }, 15_000);
  });

  describe("a charge times out, then the same key reveals it", () => {
    // The provider charges at once but answers after 600 ms; the API waits 150 ms: the first attempt
    // times out, and the second one (same key) finds the charge already recorded.
    useStack({ MOCK_PAYMENT_TIMEOUT_RATE: "1", MOCK_PAYMENT_HANG_MS: "600" }, { PAYMENT_TIMEOUT_MS: "150" });

    it("completes the order with exactly one charge", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);

      const res = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0]] }).expect(201);

      expect(res.body.status).toBe("issued");
      expect(await payments()).toEqual(["timeout", "succeeded"]);
      expect((await ledger()).totals.charges).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 650)); // let the first hung response finish
    });
  });

  describe("the provider is down", () => {
    useStack({}, {}, "http://127.0.0.1:1");

    it("answers 503, fails the order, charges nothing and keeps the hold for a retry", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const body = { eventId: s.eventId, seatIds: [s.seatIds[0]] };

      const res = await order(0, "k1", body).expect(503);
      expect(res.body.code).toBe("PAYMENT_PROVIDER_UNAVAILABLE");

      expect((await db.query("SELECT status FROM orders")).rows).toEqual([{ status: "failed" }]);
      expect((await seatState(s.seatIds[0])).status).toBe("held"); // the buyer did nothing wrong
      expect(await payments()).toEqual(["unreachable"]); // not "declined": the card was never asked
      expect((await ledger()).totals.charges).toBe(0);
    });
  });

  describe("holds in Redis", () => {
    useStack({}, { HOLD_STORE: "redis" });

    it("buys seats held in Redis and removes the holds once they are sold", async () => {
      await hold(0, [s.seatIds[0], s.seatIds[1]]).expect(201);

      const res = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0], s.seatIds[1]] }).expect(201);

      expect(res.body).toMatchObject({ status: "issued", totalCents: 90000 });
      expect(await seatState(s.seatIds[0])).toEqual({ status: "sold", held_by: null });
      expect(await redisOwner(s.seatIds[0])).toBeNull();
      expect((await ledger()).totals.succeeded).toBe(1);
    });

    it("refuses seats held by someone else, before any charge", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      await hold(1, [s.seatIds[1]]).expect(201);

      const res = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0], s.seatIds[1]] }).expect(409);

      expect(res.body).toMatchObject({ code: "HOLD_INVALID", details: { seatIds: [s.seatIds[1]] } });
      expect((await ledger()).totals.charges).toBe(0);
    });

    it("Redis says held, Postgres says sold: Postgres wins and nothing is charged", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      await db.query("UPDATE seats SET status = 'sold' WHERE id = $1", [s.seatIds[0]]);

      const res = await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0]] }).expect(409);

      expect(res.body.code).toBe("HOLD_INVALID");
      expect((await ledger()).totals.charges).toBe(0);
    });
  });

  describe("holds in Redis, payment declined", () => {
    useStack({ MOCK_PAYMENT_FAILURE_RATE: "1" }, { HOLD_STORE: "redis" });

    it("releases the Redis hold at once", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);

      await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0]] }).expect(402);

      expect(await redisOwner(s.seatIds[0])).toBeNull();
      await hold(1, [s.seatIds[0]]).expect(201);
    });
  });

  describe("holds in Redis, Redis loses its data mid-payment", () => {
    // As "the provider answers too slowly": the first buyer's order stays pending_payment.
    useStack(
      { MOCK_PAYMENT_LATENCY_MS_MIN: "2000", MOCK_PAYMENT_LATENCY_MS_MAX: "2000" },
      { PAYMENT_TIMEOUT_MS: "100", HOLD_STORE: "redis" }
    );

    it("the pending order in Postgres still keeps a second buyer from paying for the seat", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      await order(0, "k1", { eventId: s.eventId, seatIds: [s.seatIds[0]] }).expect(202);

      await app.get(RedisService).client.flushdb(); // what a restart without persistence leaves
      await hold(1, [s.seatIds[0]]).expect(201); // Redis alone can no longer tell
      const res = await order(1, "k2", { eventId: s.eventId, seatIds: [s.seatIds[0]] }).expect(409);

      expect(res.body.code).toBe("ORDER_IN_PROGRESS");
      await new Promise((resolve) => setTimeout(resolve, 2100)); // the provider finishes in the background
      expect((await ledger()).totals.charges).toBe(1); // the first buyer's only: the second was never charged
    }, 15_000);
  });

  describe.each(["postgres", "redis"])("the reconciler, holds in %s", (store) => {
    useStack({}, { HOLD_STORE: store, RECONCILE_AFTER_SECONDS: "1" });

    /** What a replica that died right after creating the order leaves behind. */
    const stuckOrder = async (seatId: number, secondsAgo = 60) => {
      const orders = app.get(OrdersModel);
      const created = await orders.create(s.userIds[0], s.eventId, 45000);
      await orders.addItems(created.id, [{ id: seatId, priceCents: 45000 }]);
      await db.query("UPDATE orders SET updated_at = now() - make_interval(secs => $2) WHERE id = $1", [created.id, secondsAgo]);
      return created.id;
    };
    const reconcile = () => app.get(OrdersService).reconcileStuckOrders();
    const orderStatus = async (id: string) => (await db.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status;

    it("finishes an order charged before the crash, without charging again", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const id = await stuckOrder(s.seatIds[0]);
      await request(mockUrl).post("/charges").send({ idempotencyKey: `order-${id}`, amountCents: 45000 }).expect(200);

      expect(await reconcile()).toBe(1);

      expect(await orderStatus(id)).toBe("issued");
      expect(await seatState(s.seatIds[0])).toEqual({ status: "sold", held_by: null });
      expect((await ledger()).totals).toMatchObject({ charges: 1, succeeded: 1 });
    });

    it("finishes an order the crash left uncharged: the buyer asked for it", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const id = await stuckOrder(s.seatIds[0]);

      await reconcile();

      expect(await orderStatus(id)).toBe("issued");
      expect((await ledger()).totals).toMatchObject({ charges: 1, succeeded: 1 });
    });

    it("two replicas at the same moment: each order is finished once", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const id = await stuckOrder(s.seatIds[0]);

      const looked = await Promise.all([reconcile(), reconcile(), reconcile()]);

      expect(looked.reduce((a, b) => a + b, 0)).toBe(1);
      expect(await orderStatus(id)).toBe("issued");
      expect((await ledger()).totals.charges).toBe(1);
    });

    it("a replica that cannot reach the provider gives the order back to the others", async () => {
      const saved = { ...process.env };
      Object.assign(process.env, { HOLD_STORE: store, RECONCILE_AFTER_SECONDS: "1" }); // provider: 127.0.0.1:1
      const broken = await createTestApp().finally(() => (process.env = saved));
      try {
        await hold(0, [s.seatIds[0]]).expect(201);
        const id = await stuckOrder(s.seatIds[0]);

        expect(await broken.get(OrdersService).reconcileStuckOrders()).toBe(1);
        expect(await orderStatus(id)).toBe("pending_payment");

        expect(await reconcile()).toBe(1); // at once, not after the lease would have run out
        expect(await orderStatus(id)).toBe("issued");
      } finally {
        await broken.close();
      }
    });

    it("leaves an order alone while its request may still be working on it", async () => {
      await hold(0, [s.seatIds[0]]).expect(201);
      const id = await stuckOrder(s.seatIds[0], 0);

      expect(await reconcile()).toBe(0);
      expect(await orderStatus(id)).toBe("pending_payment");
    });
  });
});
