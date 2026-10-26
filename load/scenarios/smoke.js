// smoke: one buyer walks the whole flow once. Proves the system works end to end
// before any load scenario is worth running. Grows with every new endpoint.
import { check } from "k6";
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
  check(request("POST", `/api/v1/events/${EVENT_ID}/holds`, { token, body: { seatIds: [seatId] }, name: "POST /api/v1/events/:id/holds" }), {
    "hold: 201": (r) => r.status === 201,
    "hold: the requested seat": (r) => r.json("seats.0.id") === seatId,
  });

  // Buy it: one charge at the mock provider; a repeated key replays the answer instead of buying twice.
  const orderBody = { eventId: EVENT_ID, seatIds: [seatId] };
  const orderKey = `smoke-${Date.now()}`;
  const bought = request("POST", "/api/v1/orders", { token, body: orderBody, name: "POST /api/v1/orders", headers: { "Idempotency-Key": orderKey } });
  check(bought, { "order: 201 paid, or 402 when the mock declines": (r) => (r.status === 201 && r.json("status") === "paid") || r.status === 402 });
  if (bought.status === 201) {
    check(request("POST", "/api/v1/orders", { token, body: orderBody, name: "POST /api/v1/orders", headers: { "Idempotency-Key": orderKey } }), {
      "order: a repeated key replays the same order": (r) => r.status === 201 && r.json("id") === bought.json("id"),
    });
    check(request("GET", `/api/v1/orders/${bought.json("id")}`, { token, name: "GET /api/v1/orders/:id" }), { "order: readable": (r) => r.status === 200 });
    return; // seat is sold: nothing left to list or release
  }

  check(request("GET", `/api/v1/events/${EVENT_ID}/holds/me`, { token, name: "GET /api/v1/events/:id/holds/me" }), {
    "my holds: the seat just held": (r) => r.json("seats.0.id") === seatId,
  });
  check(request("DELETE", `/api/v1/events/${EVENT_ID}/holds/me`, { token, name: "DELETE /api/v1/events/:id/holds/me" }), {
    "release: 204": (r) => r.status === 204,
  });
  check(request("GET", `/api/v1/events/${EVENT_ID}/availability`, { name: "GET /api/v1/events/:id/availability" }), {
    "release: all 10,000 seats free again": (r) => r.json("sections").reduce((sum, s) => sum + s.available, 0) === 10000,
  });

  check(request("POST", "/api/v1/auth/logout", { token }), { "logout: 204": (r) => r.status === 204 });
}
