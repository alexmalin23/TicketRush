import type { Pool } from "pg";
import { appDefinition } from "../../src/app";
import { ExpressFactory } from "../../src/core";
import { PG_POOL } from "../../src/database/database.constants";
import { DatabaseService } from "../../src/database/database.service";
import { runMigrations } from "../../src/database/migrate";
import { createTestApp, http, resetDatabase } from "../helpers/test-app";

describe("Database & lifecycle (e2e)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("migrations are idempotent", async () => {
    const app = await createTestApp();
    await expect(runMigrations(app.get<Pool>(PG_POOL))).resolves.toEqual([]);
    await app.close();
  });

  it("transaction() rolls back all writes when the callback throws", async () => {
    const app = await createTestApp();
    await resetDatabase(app);
    const db = app.get(DatabaseService);

    await expect(
      db.transaction(async (client) => {
        await client.query("INSERT INTO products (name, price) VALUES ('ghost', 1)");
        throw new Error("something failed after the insert");
      })
    ).rejects.toThrow("something failed");

    const { rows } = await db.query("SELECT * FROM products WHERE name = 'ghost'");
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("answers 503 instead of hanging when the pool is exhausted", async () => {
    process.env.DB_POOL_MAX = "1";
    process.env.DB_CONNECTION_TIMEOUT_MS = "200";
    const app = await createTestApp();
    const pool = app.get<Pool>(PG_POOL);

    const held = await pool.connect(); // take the only connection
    const res = await http(app).get("/products").expect(503);
    expect(res.body.message).toMatch(/temporarily unavailable/);

    held.release();
    await http(app).get("/products").expect(200);
    await app.close();
  });

  it("close() is graceful: stops the server and ends the pool, and is safe to call twice", async () => {
    const app = await createTestApp();
    const server = await app.listen(0);
    const pool = app.get<Pool>(PG_POOL);

    await app.close();
    await app.close();
    expect(server.listening).toBe(false);
    expect(pool.ended).toBe(true);
  });

  it("fails fast at startup when the database is unreachable", async () => {
    process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:1/nowhere";
    process.env.DB_CONNECTION_TIMEOUT_MS = "1000";
    await expect(ExpressFactory.create(appDefinition)).rejects.toThrow();
  });

  it("fails fast at startup when Redis is unreachable", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    await expect(ExpressFactory.create(appDefinition)).rejects.toThrow("Redis is unreachable at startup");
  });

  it("fails fast at startup when the environment is invalid", async () => {
    process.env.JWT_SECRET = "short";
    await expect(ExpressFactory.create(appDefinition)).rejects.toThrow("Invalid environment variables");
  });
});
