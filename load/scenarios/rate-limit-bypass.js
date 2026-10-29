// rate-limit-bypass: one buyer fires ATTEMPTS (default 30) hold attempts back to back.
// Correct behavior: at most LIMIT (HOLD_RATE_LIMIT, default 5) get past the limiter, the rest
// are 429. A limiter that counts in each API process lets through up to LIMIT x replicas.
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { EVENT_ID, firstSeatId, login, request, resetEvent, testUser } from "../lib/api.js";
import { report, SUMMARY_TREND_STATS } from "../lib/report.js";

const ATTEMPTS = Number(__ENV.ATTEMPTS || 30);
const LIMIT = Number(__ENV.LIMIT || 5);
const ROUTES = ["POST /api/v1/events/:id/holds"];

const allowed = new Counter("attempts_allowed"); // reached the hold logic (201 or 409)
const limited = new Counter("attempts_limited"); // 429
const unexpected = new Counter("unexpected_answers");

http.setResponseCallback(http.expectedStatuses(201, 409, 429));

export const options = {
  scenarios: { bypass: { executor: "per-vu-iterations", vus: 1, iterations: 1, maxDuration: "1m" } },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    attempts_allowed: [`count<=${LIMIT}`], // the claim: the limit holds for the whole system
    unexpected_answers: ["count==0"],
  },
};

export function setup() {
  resetEvent();
  return { seatId: firstSeatId("A"), token: login(testUser(1), "setup") };
}

export default function ({ seatId, token }) {
  // The same seat every time: the first attempt holds it, the next ones are 409 (or 429).
  for (let i = 0; i < ATTEMPTS; i++) {
    const res = request("POST", `/api/v1/events/${EVENT_ID}/holds`, {
      token,
      body: { seatIds: [seatId] },
      name: "POST /api/v1/events/:id/holds",
    });
    if (res.status === 201 || res.status === 409) allowed.add(1);
    else if (res.status === 429) limited.add(1);
    else unexpected.add(1);
    check(res, { "hold: 201, 409 or 429": (r) => [201, 409, 429].includes(r.status) });
  }
}

export const handleSummary = report("rate-limit-bypass", ROUTES);
