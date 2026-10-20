// Runs before every test file (jest.config.js -> setupFiles).
import "reflect-metadata";
import { loadDotEnvFile } from "../src/config/env";

loadDotEnvFile();

process.env.NODE_ENV = "test";
// Tests TRUNCATE tables, so they must never touch the development database.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/modex_test";
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars";
// Quiet by default; run with TEST_LOG_LEVEL=info to see request logs.
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "silent";
