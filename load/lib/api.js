// Shared HTTP helpers for every k6 scenario. Runs inside k6 (Go JS runtime), not Node.
import http from "k6/http";
import { fail } from "k6";

// Inside the Compose network the API is "api:3000"; this never goes through the host's localhost.
export const BASE_URL = __ENV.BASE_URL || "http://api:3000";
export const EVENT_ID = Number(__ENV.EVENT_ID || 1);
export const USER_PASSWORD = "password123";

export const testUser = (n) => `user${n}@test.local`;

/**
 * Every request carries a `name` tag (the route, e.g. "GET /api/v1/events/:id"), so metrics
 * group by route instead of by concrete URL, and a `phase` tag, so setup traffic
 * (logins, reset) never pollutes the numbers of the scenario itself.
 */
export function request(method, path, { body, token, name, phase = "main" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return http.request(method, `${BASE_URL}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers,
    tags: { name: name || `${method} ${path}`, phase },
  });
}

export function login(email, phase = "main") {
  const res = request("POST", "/api/v1/auth/login", { body: { email, password: USER_PASSWORD }, phase });
  if (res.status !== 200) fail(`login ${email} failed: ${res.status} ${res.body}`);
  return res.json("accessToken");
}

/** Puts the event back to its on-sale starting point; call it from setup(). */
export function resetEvent(eventId = EVENT_ID) {
  const res = request("POST", `/api/v1/dev/events/${eventId}/reset`, {
    name: "POST /api/v1/dev/events/:id/reset",
    phase: "setup",
  });
  if (res.status !== 200) {
    fail(`event reset failed: ${res.status} ${res.body} (seeded? ENABLE_DEV_ROUTES=true?)`);
  }
  return res.json();
}

/**
 * Logs in users 1..count in parallel batches (setup only). scrypt makes each login cost ~50 ms
 * of server CPU, so this belongs in setup(), never in the measured part of a scenario.
 */
export function loginMany(count, batchSize = 50) {
  const tokens = [];
  for (let start = 1; start <= count; start += batchSize) {
    const batch = [];
    for (let n = start; n < Math.min(start + batchSize, count + 1); n++) {
      batch.push([
        "POST",
        `${BASE_URL}/api/v1/auth/login`,
        JSON.stringify({ email: testUser(n), password: USER_PASSWORD }),
        { headers: { "Content-Type": "application/json" }, tags: { name: "POST /api/v1/auth/login", phase: "setup" } },
      ]);
    }
    for (const res of http.batch(batch)) {
      if (res.status !== 200) fail(`login failed: ${res.status} ${res.body}`);
      tokens.push(res.json("accessToken"));
    }
  }
  return tokens;
}

/** Id of the first seat (row 1, number 1) of a section. */
export function firstSeatId(section = "A", eventId = EVENT_ID) {
  const res = request("GET", `/api/v1/events/${eventId}/seats?section=${section}`, {
    name: "GET /api/v1/events/:id/seats",
    phase: "setup",
  });
  if (res.status !== 200) fail(`seat map failed: ${res.status} ${res.body}`);
  return res.json("seats.0.id");
}
