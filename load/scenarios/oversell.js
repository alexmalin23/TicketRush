// oversell: VUS buyers (default 500) try to hold the SAME seat at the same moment.
// Correct behavior: exactly one 201, everyone else 409 SEAT_UNAVAILABLE.
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { EVENT_ID, firstSeatId, loginMany, request, resetEvent } from "../lib/api.js";
import { report, routeThresholds, SUMMARY_TREND_STATS } from "../lib/report.js";

const VUS = Number(__ENV.VUS || 500);
const ROUTES = ["POST /api/v1/events/:id/holds"];

const succeeded = new Counter("holds_succeeded");
const rejected = new Counter("holds_rejected");
const unexpected = new Counter("holds_unexpected");

// 409 SEAT_UNAVAILABLE is the correct answer for every buyer but one: not an error.
http.setResponseCallback(http.expectedStatuses(201, 409));

export const options = {
  setupTimeout: "2m",
  scenarios: {
    // Every VU fires exactly one request as soon as setup ends: a simultaneous start.
    oversell: { executor: "per-vu-iterations", vus: VUS, iterations: 1, maxDuration: "1m" },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    holds_succeeded: ["count==1"], // the correctness claim: one seat, one holder
    holds_unexpected: ["count==0"], // anything other than 201 / 409
    ...routeThresholds(ROUTES),
  },
};

export function setup() {
  resetEvent();
  return { seatId: firstSeatId("A"), tokens: loginMany(VUS) };
}

export default function ({ seatId, tokens }) {
  const res = request("POST", `/api/v1/events/${EVENT_ID}/holds`, {
    token: tokens[__VU - 1],
    body: { seatIds: [seatId] },
    name: "POST /api/v1/events/:id/holds",
  });
  if (res.status === 201) succeeded.add(1);
  else if (res.status === 409 && res.json("code") === "SEAT_UNAVAILABLE") rejected.add(1);
  else unexpected.add(1);
  check(res, { "hold: 201 or 409": (r) => r.status === 201 || r.status === 409 });
}

export const handleSummary = report("oversell", ROUTES);
