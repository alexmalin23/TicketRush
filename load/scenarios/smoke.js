// smoke: one buyer walks the whole flow once. Proves the system works end to end
// before any load scenario is worth running. Grows with every new endpoint.
import { check } from "k6";
import { request, login, resetEvent, testUser } from "../lib/api.js";
import { report, routeThresholds, SUMMARY_TREND_STATS } from "../lib/report.js";

const ROUTES = ["GET /health", "GET /ready", "POST /api/v1/auth/login", "GET /api/v1/me", "POST /api/v1/auth/logout"];

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

  const email = testUser(1);
  const token = login(email);
  check(request("GET", "/api/v1/me", { token }), {
    "me: 200": (r) => r.status === 200,
    "me: same user": (r) => r.json("email") === email,
  });
  check(request("POST", "/api/v1/auth/logout", { token }), { "logout: 204": (r) => r.status === 204 });
}
