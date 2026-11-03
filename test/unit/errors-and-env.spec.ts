import { loadEnv } from "../../src/config/env";
import { ConflictException, toErrorBody } from "../../src/core";

describe("toErrorBody", () => {
  it("keeps HttpException status, message and details", () => {
    expect(toErrorBody(new ConflictException("taken", { field: "email" }))).toEqual({
      statusCode: 409,
      error: "Conflict",
      code: "CONFLICT",
      message: "taken",
      details: { field: "email" },
    });
  });

  it("maps a Postgres unique violation to 409", () => {
    expect(toErrorBody({ code: "23505", message: "duplicate key ..." }).statusCode).toBe(409);
  });

  it("maps a foreign key violation to 409", () => {
    expect(toErrorBody({ code: "23503" }).statusCode).toBe(409);
  });

  it("maps pool exhaustion to 503", () => {
    const error = new Error("timeout exceeded when trying to connect");
    expect(toErrorBody(error).statusCode).toBe(503);
  });

  it("turns anything else into a generic 500 without leaking the message", () => {
    expect(toErrorBody(new Error("password=hunter2"))).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      code: "INTERNAL",
      message: "Internal server error",
    });
    expect(toErrorBody(undefined).statusCode).toBe(500);
  });
});

describe("loadEnv", () => {
  it("lists every missing or invalid variable", () => {
    expect(() => loadEnv({ JWT_SECRET: "short" })).toThrow(/DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_SECRET/);
  });

  it("coerces numbers and applies defaults", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://localhost/db",
      REDIS_URL: "redis://localhost:6379",
      JWT_SECRET: "x".repeat(20),
      PORT: "8080",
    });
    expect(env.PORT).toBe(8080);
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.ENABLE_DEV_ROUTES).toBe(false);
  });

  it("refuses READ_ROUTING=replica without a replica URL (an empty one counts as none)", () => {
    const base = { DATABASE_URL: "postgres://localhost/db", REDIS_URL: "redis://localhost:6379", JWT_SECRET: "x".repeat(20) };
    expect(loadEnv(base).READ_ROUTING).toBe("primary");
    expect(() => loadEnv({ ...base, READ_ROUTING: "replica", DATABASE_REPLICA_URL: "" })).toThrow(/DATABASE_REPLICA_URL/);
    expect(loadEnv({ ...base, READ_ROUTING: "replica", DATABASE_REPLICA_URL: "postgres://replica/db" }).DATABASE_REPLICA_URL).toBe(
      "postgres://replica/db"
    );
  });
});
