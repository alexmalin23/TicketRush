// smoke: one buyer walks the whole flow once. Proves the system works end to end
// before any load scenario is worth running. Grows with every new endpoint.
import { check, sleep } from "k6";
import { EVENT_ID, request, login, resetEvent, testUser } from "../lib/api.js";
import { report, routeThresholds, SUMMARY_TREND_STATS } from "../lib/report.js";

const ROUTES = [
  "GET /health",
  "GET /ready",
  "GET /api/v1/events",
  "GET /api/v1/events/:id",
  "GET /api/v1/events/:id/availability",
  "GET /api/v1/events/:id/seats",
  "POST /api/v1/auth/login",
  "GET /api/v1/me",
  "POST /api/v1/events/:id/holds",
  "GET /api/v1/events/:id/holds/me",
  "POST /api/v1/orders",
  "GET /api/v1/orders/:id",
  "GET /api/v1/orders/:id/tickets",
  "GET /api/v1/dev/events/:id/invariants",
  "DELETE /api/v1/events/:id/holds/me",
  "POST /api/v1/auth/logout",
];

export const options = {
  vus: 1,
  iterations: 1,
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    checks: ["rate==1"], // every check passes
    http_req_failed: ["rate==0"], // no failed request at all
    ...routeThresholds(ROUTES),
  },
};

export const handleSummary = report("smoke", ROUTES);

const availability = () => request("GET", `/api/v1/events/${EVENT_ID}/availability`, { name: "GET /api/v1/events/:id/availability" });
const freeSeats = (res) => res.json("sections").reduce((sum, section) => sum + section.available, 0);

/** Every buying scenario ends with these: the database cross-checked against the provider's ledger. */
function checkInvariants() {
  const res = request("GET", `/api/v1/dev/events/${EVENT_ID}/invariants`, { name: "GET /api/v1/dev/events/:id/invariants", phase: "check" });
  check(res, { "invariants: zero violations": (r) => r.status === 200 && r.json("violations") === 0 });
}

export function setup() {
  resetEvent();
}

export default function () {
  check(request("GET", "/health"), { "health: 200": (r) => r.status === 200 });
  check(request("GET", "/ready"), {
    "ready: 200": (r) => r.status === 200,
    "ready: postgres and redis up": (r) => r.json("checks.postgres") === "up" && r.json("checks.redis") === "up",
  });

  // Browse: the buyer finds the event and looks at a section before logging in.
  check(request("GET", "/api/v1/events"), { "events: lists the event": (r) => r.json().some((e) => e.id === EVENT_ID) });
  check(request("GET", `/api/v1/events/${EVENT_ID}`, { name: "GET /api/v1/events/:id" }), {
    "event: 10 sections": (r) => r.json("sections").length === 10,
  });
  check(request("GET", `/api/v1/events/${EVENT_ID}/availability`, { name: "GET /api/v1/events/:id/availability" }), {
    "availability: all 10,000 seats free after reset": (r) =>
      r.json("sections").reduce((sum, s) => sum + s.available, 0) === 10000,
  });
  check(request("GET", `/api/v1/events/${EVENT_ID}/seats?section=A`, { name: "GET /api/v1/events/:id/seats" }), {
    "seat map: 1,000 seats in A": (r) => r.json("seats").length === 1000,
  });

  const email = testUser(1);
  const token = login(email);
  check(request("GET", "/api/v1/me", { token }), {
    "me: 200": (r) => r.status === 200,
    "me: same user": (r) => r.json("email") === email,
  });

  // Hold the first seat of section A (the event was reset in setup, so it is free).
  const seatMap = request("GET", `/api/v1/events/${EVENT_ID}/seats?section=A`, { name: "GET /api/v1/events/:id/seats" });
  const seatId = seatMap.json("seats.0.id");
  const holdSeat = () =>
    request("POST", `/api/v1/events/${EVENT_ID}/holds`, { token, body: { seatIds: [seatId] }, name: "POST /api/v1/events/:id/holds" });
  check(holdSeat(), {
    "hold: 201": (r) => r.status === 201,
    "hold: the requested seat": (r) => r.json("seats.0.id") === seatId,
  });
  check(request("GET", `/api/v1/events/${EVENT_ID}/holds/me`, { token, name: "GET /api/v1/events/:id/holds/me" }), {
    "my holds: the seat just held": (r) => r.json("seats.0.id") === seatId,
  });

  // Release it: the seat is available again at once. Then hold it again to buy.
  check(request("DELETE", `/api/v1/events/${EVENT_ID}/holds/me`, { token, name: "DELETE /api/v1/events/:id/holds/me" }), {
    "release: 204": (r) => r.status === 204,
  });
  check(availability(), { "release: all 10,000 seats free again": (r) => freeSeats(r) === 10000 });
  check(holdSeat(), { "hold again: 201": (r) => r.status === 201 });

  // Buy it: one charge at the mock provider; a repeated key replays the answer instead of buying twice.
  const orderBody = { eventId: EVENT_ID, seatIds: [seatId] };
  const orderKey = `smoke-${Date.now()}`;
  const placeOrder = () =>
    request("POST", "/api/v1/orders", { token, body: orderBody, name: "POST /api/v1/orders", headers: { "Idempotency-Key": orderKey } });
  // The worker decides an async order; a buyer's client polls, and so does this.
  const awaitOrder = (id) => {
    for (let i = 0; i < 30; i++) {
      const status = request("GET", `/api/v1/orders/${id}`, { token, name: "GET /api/v1/orders/:id" }).json("status");
      if (status !== "pending_payment") return status;
      sleep(1);
    }
    return "pending_payment";
  };
  const bought = placeOrder();
  check(bought, {
    "order: 202 pending, or with ORDER_PROCESSING=sync 201 issued or 402 declined": (r) => r.status === 202 || (r.status === 201 && r.json("status") === "issued") || r.status === 402,
  });
  const outcome = bought.status === 202 ? awaitOrder(bought.json("id")) : bought.status === 201 ? "issued" : "failed";
  const replays = (r) => r.status === bought.status && (bought.status === 402 || r.json("id") === bought.json("id"));

  if (outcome === "issued") {
    check(placeOrder(), { "order: a repeated key replays the same order": replays });
    check(request("GET", `/api/v1/orders/${bought.json("id")}`, { token, name: "GET /api/v1/orders/:id" }), { "order: readable": (r) => r.status === 200 });
    check(request("GET", `/api/v1/orders/${bought.json("id")}/tickets`, { token, name: "GET /api/v1/orders/:id/tickets" }), {
      "tickets: one per seat, with a code": (r) => r.json().length === 1 && r.json("0.code").length >= 16,
    });
    check(availability(), { "sold: the seat is no longer available": (r) => freeSeats(r) === 9999 });
  } else {
    // Declined (about 1 in 10 with the default mock): the order failed and the seat is free again at once.
    check(placeOrder(), { "declined: a repeated key replays the same answer": replays });
    check(request("GET", `/api/v1/events/${EVENT_ID}/holds/me`, { token, name: "GET /api/v1/events/:id/holds/me" }), {
      "declined: nothing is held any more": (r) => r.json("seats").length === 0,
    });
    check(availability(), { "declined: all 10,000 seats free": (r) => freeSeats(r) === 10000 });
  }
  checkInvariants();

  check(request("POST", "/api/v1/auth/logout", { token }), { "logout: 204": (r) => r.status === 204 });
}
