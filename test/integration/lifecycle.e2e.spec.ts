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
        await client.query("INSERT INTO venues (name) VALUES ('ghost')");
        throw new Error("something failed after the insert");
      })
    ).rejects.toThrow("something failed");

    const { rows } = await db.query("SELECT * FROM venues WHERE name = 'ghost'");
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("answers 503 instead of hanging when the pool is exhausted", async () => {
    process.env.DB_POOL_MAX = "1";
    process.env.DB_CONNECTION_TIMEOUT_MS = "200";
    const app = await createTestApp();
    const pool = app.get<Pool>(PG_POOL);

    // Any route that queries the database; an unknown email still runs one SELECT.
    const login = () => http(app).post("/api/v1/auth/login").send({ email: "nobody@example.com", password: "x" });

    const held = await pool.connect(); // take the only connection
    const res = await login().expect(503);
    expect(res.body.message).toMatch(/temporarily unavailable/);

    held.release();
    await login().expect(401); // reached the database again: unknown user, not 503
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

  it("reads stay on the primary unless READ_ROUTING=replica", async () => {
    const app = await createTestApp();
    const db = app.get(DatabaseService);
    expect(db.reader).toBe(db);
    await app.close();
  });

  it("READ_ROUTING=replica reads through a second pool, checked at startup and closed on shutdown", async () => {
    // CI runs no replica: a second pool to the same database stands in for one.
    process.env.READ_ROUTING = "replica";
    process.env.DATABASE_REPLICA_URL = process.env.DATABASE_URL;
    const app = await createTestApp();
    const db = app.get(DatabaseService);
    expect(db.reader).not.toBe(db);
    await expect(db.reader.query("SELECT 1 AS one")).resolves.toMatchObject({ rows: [{ one: 1 }] });
    await app.close();
    await expect(db.reader.query("SELECT 1")).rejects.toThrow();
  });

  it("fails fast at startup when the replica is unreachable", async () => {
    process.env.READ_ROUTING = "replica";
    process.env.DATABASE_REPLICA_URL = "postgres://postgres:postgres@127.0.0.1:1/modex";
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
