import request from "supertest";
import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { buildScenario, holdRequest, Scenario } from "../helpers/scenario";
import { startStack } from "../helpers/stack";
import { bearer, http } from "../helpers/test-app";

const API = "/api/v1";

/** The checks every buying scenario ends with. They are only worth anything if they CATCH problems. */
describe("Correctness invariants (e2e)", () => {
  let app: ModexApplication;
  let db: DatabaseService;
  let s: Scenario;
  let mockUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const stack = await startStack({ MOCK_PAYMENT_FAILURE_RATE: "0.3" }); // a mix of paid and declined orders
    ({ app, stop } = stack);
    mockUrl = stack.mock.url;
    db = app.get(DatabaseService);
  });
  afterAll(() => stop());
  beforeEach(async () => {
    s = await buildScenario(app, 12, 20);
    await request(mockUrl).delete("/ledger");
  });

  const invariants = async () => (await http(app).get(`${API}/dev/events/${s.eventId}/invariants`).expect(200)).body;
  const newOrder = async (status: string, totalCents: number, userIndex = 1) =>
    (
      await db.query<{ id: string }>(
        "INSERT INTO orders (user_id, event_id, status, total_cents) VALUES ($1, $2, $3, $4) RETURNING id",
        [s.userIds[userIndex], s.eventId, status, totalCents]
      )
    ).rows[0].id;
  // Forced to succeed: the provider here declines 30% at random, and these tests set up a known state.
  const providerCharge = (key: string, amountCents: number) =>
    request(mockUrl).post("/charges").set("Mock-Outcome", "succeed").send({ idempotencyKey: key, amountCents }).expect(200);

  it("a heavy mixed run ends with zero violations", async () => {
    // 20 buyers fight for 6 seats; each winner pays at once. Some payments are declined at random.
    const contested = s.seatIds.slice(0, 6);
    const holds = await Promise.all(
      s.tokens.map((token, i) => holdRequest(app, s.eventId)(token, [contested[i % 6]]).then((res) => ({ res, i })))
    );
    const winners = holds.filter(({ res }) => res.status === 201);
    expect(winners).toHaveLength(6); // exactly one winner per seat

    await Promise.all(
      winners.map(({ i }) =>
        http(app).post(`${API}/orders`).set(bearer(s.tokens[i])).set("Idempotency-Key", `buy-${i}`).send({ eventId: s.eventId, seatIds: [contested[i % 6]] })
      )
    );

    const result = await invariants();
    expect(result.violations).toBe(0);
    expect(result.checks).toEqual({
      soldSeatsWithoutTicket: 0, ticketsForUnsoldSeats: 0, seatsSoldTwice: 0, issuedOrdersWithoutTickets: 0,
      ticketsWithoutIssuedOrder: 0, chargedButFailedOrders: 0, issuedOrdersWithoutCharge: 0, amountMismatches: 0, chargesWithoutOrder: 0,
    });
    const { ordersIssued, ordersFailed, ticketsIssued, seatsSold, capturedCents } = result.totals;
    expect(ordersIssued + ordersFailed).toBe(6);
    expect(seatsSold).toBe(ordersIssued);
    expect(ticketsIssued).toBe(ordersIssued);
    expect(capturedCents).toBe(ordersIssued * 45000);
    expect(result.awaitingReconciliation).toBe(0);
  });

  describe("every check reports a real violation", () => {
    it("a sold seat without a ticket", async () => {
      await db.query("UPDATE seats SET status = 'sold' WHERE id = $1", [s.seatIds[0]]);
      const result = await invariants();
      expect(result.checks.soldSeatsWithoutTicket).toBe(1);
      expect(result.violations).toBeGreaterThan(0);
    });

    it("a ticket for a seat that is not sold, whose order is not issued", async () => {
      const orderId = await newOrder("pending_payment", 45000);
      await db.query("INSERT INTO tickets (order_id, event_id, seat_id, code) VALUES ($1, $2, $3, 'x')", [orderId, s.eventId, s.seatIds[0]]);
      const result = await invariants();
      expect(result.checks.ticketsForUnsoldSeats).toBe(1);
      expect(result.checks.ticketsWithoutIssuedOrder).toBe(1);
    });

    it("an issued order with fewer tickets than seats", async () => {
      const orderId = await newOrder("issued", 90000);
      await db.query("INSERT INTO order_items (order_id, seat_id, price_cents) VALUES ($1, $2, 45000), ($1, $3, 45000)", [
        orderId, s.seatIds[0], s.seatIds[1],
      ]);
      expect((await invariants()).checks.issuedOrdersWithoutTickets).toBe(1);
    });

    it("a provider charge that matches no order", async () => {
      await providerCharge("order-00000000-0000-4000-8000-000000000000", 100);
      expect((await invariants()).checks.chargesWithoutOrder).toBe(1);
    });

    it("a successful charge for an order that failed", async () => {
      const orderId = await newOrder("failed", 45000);
      await providerCharge(`order-${orderId}`, 45000);
      expect((await invariants()).checks.chargedButFailedOrders).toBe(1);
    });

    it("an issued order the provider never charged", async () => {
      await newOrder("issued", 45000);
      expect((await invariants()).checks.issuedOrdersWithoutCharge).toBe(1);
    });

    it("a charge whose amount differs from the order total", async () => {
      const orderId = await newOrder("pending_payment", 500);
      await providerCharge(`order-${orderId}`, 600);
      const result = await invariants();
      expect(result.checks.amountMismatches).toBe(1);
    });
  });

  it("resetting the event also clears the provider ledger, so the two records stay comparable", async () => {
    await providerCharge("order-00000000-0000-4000-8000-000000000000", 100);
    expect((await invariants()).checks.chargesWithoutOrder).toBe(1);

    await http(app).post(`${API}/dev/events/${s.eventId}/reset`).expect(200);

    expect((await request(mockUrl).get("/ledger").expect(200)).body.totals.charges).toBe(0);
    expect((await invariants()).violations).toBe(0);
  });

  it("a charge that succeeded while the order waits is reported as awaiting reconciliation, not as a violation", async () => {
    const orderId = await newOrder("pending_payment", 45000);
    await providerCharge(`order-${orderId}`, 45000);
    const result = await invariants();
    expect(result.awaitingReconciliation).toBe(1);
    expect(result.violations).toBe(0);
  });
});
