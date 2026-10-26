import { ConflictException, HttpException, ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { DUMMY_HASH } from "../../src/modules/auth/password";
import { IdempotencyModel } from "../../src/modules/idempotency/idempotency.model";
import { IdempotencyService } from "../../src/modules/idempotency/idempotency.service";
import { createTestApp, resetDatabase } from "../helpers/test-app";

describe("Idempotency (e2e, real Postgres)", () => {
  let app: ModexApplication;
  let db: DatabaseService;
  let idempotency: IdempotencyService;
  let model: IdempotencyModel;
  let alice: number;
  let bob: number;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
    idempotency = app.get(IdempotencyService);
    model = app.get(IdempotencyModel);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDatabase(app);
    const users = await db.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('alice@test.local', $1), ('bob@test.local', $1) RETURNING id`,
      [DUMMY_HASH]
    );
    [alice, bob] = users.rows.map((u) => u.id);
  });

  /** An operation that counts how many times it really ran. */
  const counted = (result = { status: 201, body: { orderId: "o-1" } }, delayMs = 0) => {
    const op = Object.assign(
      async () => {
        op.calls += 1;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return result;
      },
      { calls: 0 }
    );
    return op;
  };

  describe("saveKeyIfNew", () => {
    it("saves a new key once: true, then false", async () => {
      expect(await model.saveKeyIfNew(alice, "k1", "hash-a")).toBe(true);
      expect(await model.saveKeyIfNew(alice, "k1", "hash-a")).toBe(false);
    });

    it("leaves an existing record untouched", async () => {
      await model.saveKeyIfNew(alice, "k1", "hash-a");
      await model.saveResponse(alice, "k1", 201, { orderId: "o-1" });
      expect(await model.saveKeyIfNew(alice, "k1", "hash-b")).toBe(false);
      expect(await model.findKey(alice, "k1")).toMatchObject({ requestHash: "hash-a", state: "completed", responseCode: 201 });
    });

    it("keys belong to a user: the same key for two users is saved twice", async () => {
      expect(await model.saveKeyIfNew(alice, "shared", "h")).toBe(true);
      expect(await model.saveKeyIfNew(bob, "shared", "h")).toBe(true);
    });

    it("20 concurrent saves of one key: exactly one wins", async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => model.saveKeyIfNew(alice, "race", "h")));
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe("runOnce", () => {
    it("runs a new request and stores its response", async () => {
      const op = counted();
      await expect(idempotency.runOnce(alice, "k1", { seatIds: [1] }, op)).resolves.toEqual({ status: 201, body: { orderId: "o-1" } });
      expect(op.calls).toBe(1);
      expect(await model.findKey(alice, "k1")).toMatchObject({ state: "completed", responseCode: 201 });
    });

    it("replays the stored response to a retry with the same key and body, without running again", async () => {
      const op = counted();
      const first = await idempotency.runOnce(alice, "k1", { seatIds: [1, 2] }, op);
      const retry = await idempotency.runOnce(alice, "k1", { seatIds: [1, 2] }, op);
      expect(retry).toEqual(first);
      expect(op.calls).toBe(1);
    });

    it("treats the same body with keys in another order as the same request", async () => {
      const op = counted();
      await idempotency.runOnce(alice, "k1", { eventId: 1, seatIds: [1] }, op);
      await idempotency.runOnce(alice, "k1", { seatIds: [1], eventId: 1 }, op);
      expect(op.calls).toBe(1);
    });

    it("rejects the same key with a different body: 422 IDEMPOTENCY_KEY_REUSED", async () => {
      await idempotency.runOnce(alice, "k1", { seatIds: [1] }, counted());
      await expect(idempotency.runOnce(alice, "k1", { seatIds: [2] }, counted())).rejects.toMatchObject({
        statusCode: 422,
        code: "IDEMPOTENCY_KEY_REUSED",
      });
    });

    it("a retry while the first attempt still runs: 409 IDEMPOTENCY_IN_PROGRESS, then the replay", async () => {
      const slow = counted(undefined, 150);
      const first = idempotency.runOnce(alice, "k1", { seatIds: [1] }, slow);
      await new Promise((resolve) => setTimeout(resolve, 30));

      await expect(idempotency.runOnce(alice, "k1", { seatIds: [1] }, counted())).rejects.toMatchObject({
        statusCode: 409,
        code: "IDEMPOTENCY_IN_PROGRESS",
      });
      const result = await first;
      await expect(idempotency.runOnce(alice, "k1", { seatIds: [1] }, counted())).resolves.toEqual(result);
      expect(slow.calls).toBe(1);
    });

    it("20 concurrent identical requests: the operation runs exactly once", async () => {
      const op = counted(undefined, 50);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => idempotency.runOnce(alice, "k1", { seatIds: [1] }, op))
      );
      expect(op.calls).toBe(1);
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(rejected.every((r) => (r.reason as HttpException).code === "IDEMPOTENCY_IN_PROGRESS")).toBe(true);
    });

    it("a business error (4xx) is the outcome: stored and replayed, not run again", async () => {
      const failing = Object.assign(
        async () => {
          failing.calls += 1;
          throw new ConflictException("Some seats cannot be held", { seatIds: [7] }, "SEAT_UNAVAILABLE");
        },
        { calls: 0 }
      );
      const first = await idempotency.runOnce(alice, "k1", { seatIds: [7] }, failing);
      expect(first).toMatchObject({ status: 409, body: { code: "SEAT_UNAVAILABLE", details: { seatIds: [7] } } });
      expect(await idempotency.runOnce(alice, "k1", { seatIds: [7] }, failing)).toEqual(first);
      expect(failing.calls).toBe(1);
    });

    it("a crash frees the key: the retry runs again", async () => {
      await expect(
        idempotency.runOnce(alice, "k1", { seatIds: [1] }, async () => {
          throw new Error("database exploded");
        })
      ).rejects.toThrow("database exploded");
      expect(await model.findKey(alice, "k1")).toBeNull();

      const op = counted();
      await idempotency.runOnce(alice, "k1", { seatIds: [1] }, op);
      expect(op.calls).toBe(1);
    });

    it("a key older than 24 hours starts a new request", async () => {
      await idempotency.runOnce(alice, "k1", { seatIds: [1] }, counted());
      await db.query("UPDATE idempotency_keys SET created_at = now() - interval '25 hours'");

      const op = counted({ status: 201, body: { orderId: "o-2" } });
      await expect(idempotency.runOnce(alice, "k1", { seatIds: [9] }, op)).resolves.toEqual({ status: 201, body: { orderId: "o-2" } });
      expect(op.calls).toBe(1);
    });
  });
});
