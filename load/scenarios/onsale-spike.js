// onsale-spike: the on-sale moment. Load ramps from 0 to VUS in 10 s; 90% of the buyers only browse
// (availability and the seat map), 10% buy: pick a seat from the map, hold it, order it, open the ticket.
// Correctness is the point: the run ends with the invariants (zero violations), then the numbers.
//
//   npm run load -- onsale-spike --env VUS=500 --env HOLD_SECONDS=20
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { EVENT_ID, loginMany, request, resetEvent } from "../lib/api.js";
import { report, routeThresholds, SUMMARY_TREND_STATS } from "../lib/report.js";

const VUS = Number(__ENV.VUS || 500);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 30);
const BUYER_EVERY = 10; // every 10th VU buys: exactly 10%
const BUYERS = Math.floor(VUS / BUYER_EVERY);
const MAX_PURCHASES_PER_BUYER = 3; // the limit is 6 seats per event; this keeps the run about the spike, not the limit
const SECTIONS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

const ROUTES = [
  "GET /api/v1/events/:id/availability",
  "GET /api/v1/events/:id/seats",
  "POST /api/v1/events/:id/holds",
  "POST /api/v1/orders",
  "GET /api/v1/orders/:id/tickets",
];

// Expected answers are not errors: a lost race is 409 and a declined card is 402.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 402, 409));

const holdsSucceeded = new Counter("holds_succeeded");
const holdsLostRace = new Counter("holds_lost_race");
const ordersIssued = new Counter("orders_issued");
const ordersDeclined = new Counter("orders_declined");
const ordersPending = new Counter("orders_pending");
const unexpected = new Counter("unexpected_answers"); // anything outside the documented answers
const invariantViolations = new Counter("invariant_violations");
const serverOrdersIssued = new Counter("server_orders_issued");
const serverSeatsSold = new Counter("server_seats_sold");

export const options = {
  setupTimeout: "3m",
  scenarios: {
    onsale: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: VUS },
        { duration: `${HOLD_SECONDS}s`, target: VUS },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    unexpected_answers: ["count==0"],
    invariant_violations: ["count==0"], // the correctness claim
    ...routeThresholds(ROUTES),
    "http_req_failed{phase:main}": ["rate<0.001"], // unexpected errors under the spike
  },
};

export function setup() {
  resetEvent(); // also clears the provider ledger: the invariants compare both records
  return { tokens: loginMany(BUYERS) };
}

let purchases = 0; // per VU: every VU has its own copy

export default function ({ tokens }) {
  const vu = exec.vu.idInTest;
  const buyerIndex = vu % BUYER_EVERY === 0 ? vu / BUYER_EVERY - 1 : -1;
  const section = SECTIONS[Math.floor(Math.random() * SECTIONS.length)];

  if (buyerIndex >= 0 && buyerIndex < tokens.length && purchases < MAX_PURCHASES_PER_BUYER) {
    buy(tokens[buyerIndex], section);
  } else {
    browse(section);
  }
  sleep(1 + Math.random() * 2); // a person reads the screen before the next click
}

function browse(section) {
  check(request("GET", `/api/v1/events/${EVENT_ID}/availability`, { name: "GET /api/v1/events/:id/availability" }), {
    "availability: 200": (r) => r.status === 200,
  });
  check(request("GET", `/api/v1/events/${EVENT_ID}/seats?section=${section}`, { name: "GET /api/v1/events/:id/seats" }), {
    "seat map: 200": (r) => r.status === 200,
  });
}

function buy(token, section) {
  const map = request("GET", `/api/v1/events/${EVENT_ID}/seats?section=${section}`, { name: "GET /api/v1/events/:id/seats" });
  if (!check(map, { "seat map: 200": (r) => r.status === 200 })) return;
  const free = map.json("seats").filter((seat) => seat.status === "available");

  // Up to 3 tries: the map is a moment old, so a seat that looked free may already be gone.
  for (let attempt = 0; attempt < 3 && free.length > 0; attempt++) {
    const seatId = free.splice(Math.floor(Math.random() * free.length), 1)[0].id;
    const hold = request("POST", `/api/v1/events/${EVENT_ID}/holds`, {
      token, body: { seatIds: [seatId] }, name: "POST /api/v1/events/:id/holds",
    });
    if (hold.status === 409 && hold.json("code") === "SEAT_UNAVAILABLE") {
      holdsLostRace.add(1);
      continue;
    }
    if (hold.status !== 201) {
      unexpected.add(1);
      return;
    }
    holdsSucceeded.add(1);
    order(token, seatId);
    return;
  }
}

function order(token, seatId) {
  purchases += 1;
  const key = `${exec.vu.idInTest}-${purchases}-${Date.now()}`;
  const res = request("POST", "/api/v1/orders", {
    token, body: { eventId: EVENT_ID, seatIds: [seatId] }, name: "POST /api/v1/orders", headers: { "Idempotency-Key": key },
  });

  if (res.status === 201) {
    ordersIssued.add(1);
    check(request("GET", `/api/v1/orders/${res.json("id")}/tickets`, { token, name: "GET /api/v1/orders/:id/tickets" }), {
      "tickets: one per seat": (r) => r.status === 200 && r.json().length === 1,
    });
  } else if (res.status === 402) ordersDeclined.add(1);
  else if (res.status === 202) ordersPending.add(1);
  else unexpected.add(1);
}

export function teardown() {
  const res = request("GET", `/api/v1/dev/events/${EVENT_ID}/invariants`, { name: "GET /api/v1/dev/events/:id/invariants", phase: "check" });
  const ok = check(res, { "invariants: endpoint answered": (r) => r.status === 200 });
  if (!ok) {
    invariantViolations.add(1); // not being able to prove correctness is a failure too
    return;
  }
  const result = res.json();
  invariantViolations.add(result.violations);
  serverOrdersIssued.add(result.totals.ordersIssued);
  serverSeatsSold.add(result.totals.seatsSold);
  console.log(`invariants: ${JSON.stringify(result)}`);
}

export const handleSummary = report("onsale-spike", ROUTES);
