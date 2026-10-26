import request from "supertest";
import { HttpException, Logger, ModexApplication } from "../../src/core";
import type { Env } from "../../src/config/env";
import { PaymentsClient } from "../../src/modules/payments/payments.client";
import { startProvider } from "../helpers/provider";

const clientFor = (url: string, timeoutMs = 1000) =>
  new PaymentsClient({ PAYMENTS_PROVIDER_URL: url, PAYMENT_TIMEOUT_MS: timeoutMs } as Env, new Logger("silent"));

describe("Mock payment provider", () => {
  let provider: { app: ModexApplication; url: string };
  const charge = (body: object, outcome?: string) => {
    const req = request(provider.url).post("/charges");
    return outcome ? req.set("Mock-Outcome", outcome).send(body) : req.send(body);
  };
  const ledger = async () => (await request(provider.url).get("/ledger").expect(200)).body;

  beforeEach(async () => {
    provider = await startProvider({ MOCK_PAYMENT_LATENCY_MS_MIN: "20", MOCK_PAYMENT_LATENCY_MS_MAX: "40" });
  });
  afterEach(() => provider.app.close());

  it("charges once and records it in the ledger", async () => {
    const res = await charge({ idempotencyKey: "order-1", amountCents: 45000 }).expect(200);
    expect(res.body).toMatchObject({ idempotencyKey: "order-1", amountCents: 45000, status: "succeeded" });
    expect(res.body.providerRef).toMatch(/^ch_/);
    expect((await ledger()).totals).toEqual({ charges: 1, succeeded: 1, declined: 0, capturedCents: 45000 });
  });

  it("is idempotent by key: a retry returns the first charge and moves no money", async () => {
    const first = await charge({ idempotencyKey: "order-1", amountCents: 45000 }).expect(200);
    const retry = await charge({ idempotencyKey: "order-1", amountCents: 45000 }).expect(200);
    expect(retry.body.providerRef).toBe(first.body.providerRef);
    expect((await ledger()).totals.charges).toBe(1);
  });

  it("is idempotent under concurrency: 20 simultaneous duplicates, one charge", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => charge({ idempotencyKey: "order-1", amountCents: 45000 }))
    );
    expect(new Set(results.map((r) => r.body.providerRef)).size).toBe(1);
    expect((await ledger()).totals.charges).toBe(1);
  });

  it("rejects reusing a key for a different amount with 422 IDEMPOTENCY_KEY_REUSED", async () => {
    await charge({ idempotencyKey: "order-1", amountCents: 45000 }).expect(200);
    const res = await charge({ idempotencyKey: "order-1", amountCents: 99 }).expect(422);
    expect(res.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", details: { originalAmountCents: 45000 } });
    expect((await ledger()).totals.charges).toBe(1);
  });

  it("declines, and a retry of a declined charge stays declined", async () => {
    const declined = await charge({ idempotencyKey: "order-2", amountCents: 100 }, "decline").expect(200);
    expect(declined.body.status).toBe("declined");
    const retry = await charge({ idempotencyKey: "order-2", amountCents: 100 }).expect(200);
    expect(retry.body.status).toBe("declined");
    expect((await ledger()).totals).toMatchObject({ declined: 1, capturedCents: 0 });
  });

  it("a hung response has already charged: the ledger knows before the client does", async () => {
    const started = Date.now();
    // .then() sends now: a supertest request is lazy until awaited.
    const hung = charge({ idempotencyKey: "order-3", amountCents: 500 }, "hang").then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 150)); // after processing, before the response
    expect((await ledger()).totals.succeeded).toBe(1);

    const res = await hung;
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("succeeded");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("applies the configured decline rate", async () => {
    const declining = await startProvider({ MOCK_PAYMENT_FAILURE_RATE: "1" });
    const res = await request(declining.url).post("/charges").send({ idempotencyKey: "x", amountCents: 1 }).expect(200);
    expect(res.body.status).toBe("declined");
    await declining.app.close();
  });

  it("validates input and the test outcome header", async () => {
    expect((await charge({ amountCents: 1 }).expect(400)).body.code).toBe("VALIDATION_ERROR");
    expect((await charge({ idempotencyKey: "k", amountCents: 0 }).expect(400)).body.code).toBe("VALIDATION_ERROR");
    await charge({ idempotencyKey: "k", amountCents: 1 }, "explode").expect(400);
  });

  it("DELETE /ledger clears it between load runs", async () => {
    await charge({ idempotencyKey: "order-1", amountCents: 1 }).expect(200);
    await request(provider.url).delete("/ledger").expect(204);
    expect((await ledger()).totals.charges).toBe(0);
  });
});

describe("PaymentsClient", () => {
  it("maps answered charges to succeeded / declined", async () => {
    const ok = await startProvider();
    await expect(clientFor(ok.url).charge({ idempotencyKey: "a", amountCents: 100 })).resolves.toMatchObject({
      status: "succeeded",
      providerRef: expect.stringMatching(/^ch_/),
    });
    await ok.app.close();

    const declining = await startProvider({ MOCK_PAYMENT_FAILURE_RATE: "1" });
    await expect(clientFor(declining.url).charge({ idempotencyKey: "b", amountCents: 100 })).resolves.toMatchObject({
      status: "declined",
    });
    await declining.app.close();
  });

  it("timeout means unknown, not declined: the retry with the same key reveals the charge", async () => {
    const hanging = await startProvider({ MOCK_PAYMENT_TIMEOUT_RATE: "1", MOCK_PAYMENT_HANG_MS: "500" });
    const client = clientFor(hanging.url, 100);

    await expect(client.charge({ idempotencyKey: "order-9", amountCents: 700 })).resolves.toEqual({ status: "timeout" });

    // Same key: the provider already decided, so the answer comes back at once and nothing is charged twice.
    const retry = await client.charge({ idempotencyKey: "order-9", amountCents: 700 });
    expect(retry.status).toBe("succeeded");
    const ledger = (await request(hanging.url).get("/ledger").expect(200)).body;
    expect(ledger.totals.charges).toBe(1);
    expect(ledger.charges[0].providerRef).toBe((retry as { providerRef: string }).providerRef);

    await new Promise((resolve) => setTimeout(resolve, 500)); // let the hung response finish before closing
    await hanging.app.close();
  });

  it("an unreachable provider is a 503, never a silent success or decline", async () => {
    const rejection = clientFor("http://127.0.0.1:1").charge({ idempotencyKey: "c", amountCents: 1 });
    await expect(rejection).rejects.toBeInstanceOf(HttpException);
    await expect(rejection).rejects.toMatchObject({ statusCode: 503, code: "PAYMENT_PROVIDER_UNAVAILABLE" });
  });
});
