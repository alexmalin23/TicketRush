// onsale-spike: the on-sale moment. Load ramps from 0 to VUS in 10 s; 90% of the buyers only browse
// (availability and the seat map), 10% buy: pick a seat from the map, hold it, order it, open the ticket.
// Correctness is the point: the run ends with the invariants (zero violations), then the numbers.
//
// Buyers go through the waiting room first when it is on (WAITING_ROOM_ENABLED=true on the stack, and
// --env WAITING_ROOM=true here). They poll for the order's outcome, as ORDER_PROCESSING=async answers 202.
// Browsers have no login in this scenario, so the room is modelled for them: each arrives at its place in a
// line of ARRIVALS_PER_SECOND and leaves after STAY_SECONDS. Buyers (10%) use the real endpoints; set the
// stack's WAITING_ROOM_ADMIT_PER_SECOND to a tenth of ARRIVALS_PER_SECOND.
//
//   npm run load -- onsale-spike --env VUS=500 --env HOLD_SECONDS=20
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { EVENT_ID, loginMany, request, resetEvent } from "../lib/api.js";
import { report, routeThresholds, SUMMARY_TREND_STATS } from "../lib/report.js";

const VUS = Number(__ENV.VUS || 500);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 30);
const WAITING_ROOM = __ENV.WAITING_ROOM === "true";
const ARRIVALS_PER_SECOND = Number(__ENV.ARRIVALS_PER_SECOND || 50);
const STAY_SECONDS = 30;
const BUYER_EVERY = 10; // every 10th VU buys: exactly 10%
const BUYERS = Math.floor(VUS / BUYER_EVERY);
const MAX_PURCHASES_PER_BUYER = 3; // the limit is 6 seats per event; this keeps the run about the spike, not the limit
const ORDER_POLLS = 30;
const SECTIONS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

const ROUTES = [
  "GET /api/v1/events/:id/availability",
  "GET /api/v1/events/:id/seats",
  "POST /api/v1/events/:id/holds",
  "POST /api/v1/orders",
  "GET /api/v1/orders/:id",
  "POST /api/v1/events/:id/queue",
  "GET /api/v1/events/:id/queue",
  "GET /api/v1/orders/:id/tickets",
];

// Expected answers are not errors: a lost race is 409 and a declined card is 402.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 402, 409));

const holdsSucceeded = new Counter("holds_succeeded");
const holdsLostRace = new Counter("holds_lost_race");
const ordersIssued = new Counter("orders_issued");
const ordersDeclined = new Counter("orders_declined");
const ordersPending = new Counter("orders_pending"); // no outcome yet when the buyer stopped polling
const ordersUndecidedWait = new Trend("order_decision_ms", true); // order placed to order decided
const admissionWait = new Trend("admission_wait_ms", true);
const neverAdmitted = new Counter("buyers_never_admitted");
const unexpected = new Counter("unexpected_answers"); // anything outside the documented answers
const invariantViolations = new Counter("invariant_violations");
const serverOrdersIssued = new Counter("server_orders_issued");
const serverSeatsSold = new Counter("server_seats_sold");
const awaitingReconciliation = new Counter("awaiting_reconciliation"); // charged, still no ticket at the end

export const options = {
  setupTimeout: "3m",
  teardownTimeout: "2m", // room for the reconciler to finish orders a crash left behind
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
    awaiting_reconciliation: ["count==0"], // every buyer who paid ends up with a ticket
    ...routeThresholds(ROUTES),
    "http_req_failed{phase:main}": ["rate<0.001"], // unexpected errors under the spike
  },
};

export function setup() {
  resetEvent(); // also clears the provider ledger: the invariants compare both records
  return { tokens: loginMany(BUYERS) };
}

let purchases = 0; // per VU: every VU has its own copy
let accessToken = null;
let expiresAt = 0;

/** Joins the line and polls until admitted. False when the run ends first: the buyer just goes home. */
function admitted(token) {
  if (accessToken && Date.now() < expiresAt - 5000) return true;
  const started = Date.now();
  const joined = request("POST", `/api/v1/events/${EVENT_ID}/queue`, { token, name: "POST /api/v1/events/:id/queue" });
  if (joined.status !== 200) {
    unexpected.add(1);
    return false;
  }
  for (;;) {
    const res = request("GET", `/api/v1/events/${EVENT_ID}/queue`, { token, name: "GET /api/v1/events/:id/queue" });
    if (res.status === 200 && res.json("admitted")) {
      accessToken = res.json("accessToken");
      expiresAt = new Date(res.json("expiresAt")).getTime();
      admissionWait.add(Date.now() - started);
      return true;
    }
    if (res.status !== 200) {
      unexpected.add(1);
      return false;
    }
    if (exec.scenario.progress >= 0.98) {
      neverAdmitted.add(1);
      return false;
    }
    sleep(1 + Math.random());
  }
}

export default function ({ tokens }) {
  const vu = exec.vu.idInTest;
  const buyerIndex = vu % BUYER_EVERY === 0 ? vu / BUYER_EVERY - 1 : -1;
  const section = SECTIONS[Math.floor(Math.random() * SECTIONS.length)];

  if (buyerIndex >= 0 && buyerIndex < tokens.length && purchases < MAX_PURCHASES_PER_BUYER) {
    buy(tokens[buyerIndex], section);
  } else if (!WAITING_ROOM) {
    browse(section);
  } else {
    const elapsed = exec.instance.currentTestRunDuration / 1000;
    const turn = vu / ARRIVALS_PER_SECOND;
    if (elapsed >= turn && elapsed < turn + STAY_SECONDS) browse(section);
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
  if (WAITING_ROOM && !admitted(token)) return;
  const map = request("GET", `/api/v1/events/${EVENT_ID}/seats?section=${section}`, { name: "GET /api/v1/events/:id/seats" });
  if (!check(map, { "seat map: 200": (r) => r.status === 200 })) return;
  const free = map.json("seats").filter((seat) => seat.status === "available");

  // Up to 3 tries: the map is a moment old, so a seat that looked free may already be gone.
  for (let attempt = 0; attempt < 3 && free.length > 0; attempt++) {
    const seatId = free.splice(Math.floor(Math.random() * free.length), 1)[0].id;
    const hold = request("POST", `/api/v1/events/${EVENT_ID}/holds`, {
      token,
      body: { seatIds: [seatId] },
      name: "POST /api/v1/events/:id/holds",
      headers: accessToken ? { "X-Access-Token": accessToken } : undefined,
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

  if (res.status === 201) finishIssued(token, res.json("id"));
  else if (res.status === 402) ordersDeclined.add(1);
  else if (res.status === 202) pollOrder(token, res.json("id"));
  else unexpected.add(1);
}

function finishIssued(token, orderId) {
  ordersIssued.add(1);
  check(request("GET", `/api/v1/orders/${orderId}/tickets`, { token, name: "GET /api/v1/orders/:id/tickets" }), {
    "tickets: one per seat": (r) => r.status === 200 && r.json().length === 1,
  });
}

function pollOrder(token, orderId) {
  const started = Date.now();
  for (let i = 0; i < ORDER_POLLS; i++) {
    sleep(1);
    const res = request("GET", `/api/v1/orders/${orderId}`, { token, name: "GET /api/v1/orders/:id" });
    const status = res.status === 200 ? res.json("status") : null;
    if (status === "issued") {
      ordersUndecidedWait.add(Date.now() - started);
      return finishIssued(token, orderId);
    }
    if (status === "failed") {
      ordersUndecidedWait.add(Date.now() - started);
      return ordersDeclined.add(1);
    }
  }
  ordersPending.add(1);
}

const RECONCILE_WAIT_SECONDS = Number(__ENV.RECONCILE_WAIT_SECONDS || 90);

export function teardown() {
  // Orders a crashed replica left pending are finished by the reconciler, not by the buyer: wait for it.
  let res;
  for (let waited = 0; ; waited += 5) {
    res = request("GET", `/api/v1/dev/events/${EVENT_ID}/invariants`, { name: "GET /api/v1/dev/events/:id/invariants", phase: "check" });
    const settled = res.status === 200 && res.json("awaitingReconciliation") === 0 && res.json("totals.ordersPending") === 0;
    if (res.status !== 200 || settled || waited >= RECONCILE_WAIT_SECONDS) break;
    sleep(5);
  }
  const ok = check(res, { "invariants: endpoint answered": (r) => r.status === 200 });
  if (!ok) {
    invariantViolations.add(1); // not being able to prove correctness is a failure too
    return;
  }
  const result = res.json();
  awaitingReconciliation.add(result.awaitingReconciliation);
  invariantViolations.add(result.violations);
  serverOrdersIssued.add(result.totals.ordersIssued);
  serverSeatsSold.add(result.totals.seatsSold);
  console.log(`invariants: ${JSON.stringify(result)}`);
}

export const handleSummary = report("onsale-spike", ROUTES);
