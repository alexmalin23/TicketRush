// Runs before every test file (jest.config.js -> setupFiles).
import "reflect-metadata";
import { loadDotEnvFile } from "../src/config/env";

loadDotEnvFile();

process.env.NODE_ENV = "test";
// Tests TRUNCATE tables, so they must never touch the development database.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/modex_test";
// Logical database 1: tests may flush Redis, so they never share the development keyspace (0).
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1";
// No test may touch a provider running on the developer machine: stacks that need one start their own.
process.env.PAYMENTS_PROVIDER_URL = "http://127.0.0.1:1";
process.env.JWT_SECRET ??="test-secret-at-least-16-chars";
// Tests reuse user ids after every reset and the hold rate limiter remembers them in memory:
// effectively off here, except in the spec that tests it. Forced, not ??=: .env may set it.
process.env.HOLD_RATE_LIMIT = "100000";
// A cached event would hide what a test just wrote; the cache has its own spec. Forced: .env may set it.
process.env.CACHE_ENABLED = "false";
// Tests call the reconciler themselves: a timer would race them.
process.env.RECONCILE_INTERVAL_SECONDS = "0";
// Quiet by default; run with TEST_LOG_LEVEL=info to see request logs.
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "silent";
