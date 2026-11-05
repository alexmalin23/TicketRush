// stampede: one cached key under steady traffic. Availability arrives at a fixed RATE however slow the
// answers get, so each time the key expires every request until the rebuild finishes goes to Postgres.
// k6 cannot see the database: load/sample-queries.sh counts the queries per second during the run.
// Nothing is reset: 500,000 rewritten rows would leave autovacuum running during the measurement.
//
//   npm run db:seed -- large
//   CACHE_ENABLED=true npm run load -- stampede --env RATE=700 --env EVENT_ID=<the large event>
import { check } from "k6";
import { EVENT_ID, request } from "../lib/api.js";
import { report, routeThresholds, SUMMARY_TREND_STATS } from "../lib/report.js";

const RATE = Number(__ENV.RATE || 700);
const SECONDS = Number(__ENV.SECONDS || 30);
const ROUTE = "GET /api/v1/events/:id/availability";

export const options = {
  scenarios: {
    hot_key: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: `${SECONDS}s`,
      preAllocatedVUs: RATE,
      maxVUs: RATE * 10, // a slow database must queue requests, not lower the arrival rate
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: routeThresholds([ROUTE]),
};

export default function () {
  check(request("GET", `/api/v1/events/${EVENT_ID}/availability`, { name: ROUTE }), {
    "availability: 200": (r) => r.status === 200,
  });
}

export const handleSummary = report("stampede", [ROUTE]);
