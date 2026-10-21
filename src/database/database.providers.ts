import { Pool, types } from "pg";
import { FactoryProvider, Logger } from "../core";
import { ENV, Env } from "../config/env";
import { PG_POOL } from "./database.constants";

// pg returns NUMERIC columns as strings to avoid losing precision.
// Prices here are small, so we parse them to JS numbers globally.
types.setTypeParser(types.builtins.NUMERIC, (value: string) => Number(value));

// Same for BIGINT (ids of events, seats, venues): ids are numbers in the API, never strings.
// They stay far below 2^53; failing loudly beats silently rounding an id.
types.setTypeParser(types.builtins.INT8, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`BIGINT ${value} exceeds Number.MAX_SAFE_INTEGER`);
  return parsed;
});

/**
 * ONE pool for the whole app, created at startup and shared by every Model.
 * Never create a Pool per request: each Pool opens its own connections.
 */
function createPool(env: Env, logger: Logger): Pool {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX, // maximum open connections
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS, // pool exhausted -> error after this
    idleTimeoutMillis: 30_000, // close connections idle for 30s
  });

  // An idle connection can break (DB restart, network). Without this listener
  // the 'error' event would crash the whole process.
  pool.on("error", (error) => logger.error("Unexpected error on idle database client", error));
  return pool;
}

/**
 * The pg Pool is not one of our @Injectable classes, so it is registered
 * explicitly (in app.ts) under the PG_POOL token. DatabaseService then
 * receives it with @Inject(PG_POOL).
 */
export const poolProvider: FactoryProvider = {
  provide: PG_POOL,
  useFactory: (env: Env, logger: Logger) => createPool(env, logger.child("Database")),
  inject: [ENV, Logger],
};
