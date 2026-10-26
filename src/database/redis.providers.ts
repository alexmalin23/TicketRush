import Redis from "ioredis";
import { FactoryProvider, Logger } from "../core";
import { ENV, Env } from "../config/env";
import { REDIS } from "./database.constants";

/**
 * ONE Redis connection for the whole app, like the pg Pool. Redis is single-threaded
 * and pipelines commands over one socket, so a pool of connections buys nothing here.
 */
function createRedis(env: Env, logger: Logger): Redis {
  const redis = new Redis(env.REDIS_URL, {
    // Connect in RedisService.onInit, so a missing Redis fails startup with a clear error.
    lazyConnect: true,
    // While disconnected, fail commands immediately instead of queueing them in memory.
    // Under load a queue would grow without bound and turn an outage into a latency spike.
    enableOfflineQueue: false,
    // Only used when dropping a connection that is not healthy (a failed startup): there is nothing
    // left to flush, so do not hold the process open for the library's default 2 seconds.
    disconnectTimeout: 100,
  });

  // Same reason as pool.on("error"): an unhandled 'error' event would crash the process.
  redis.on("error", (error) => logger.error("Redis connection error", error.message));
  return redis;
}

/** Registered in app.ts under the REDIS token, next to the pg Pool. */
export const redisProvider: FactoryProvider = {
  provide: REDIS,
  useFactory: (env: Env, logger: Logger) => createRedis(env, logger.child("Redis")),
  inject: [ENV, Logger],
};
