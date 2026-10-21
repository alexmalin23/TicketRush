import type Redis from "ioredis";
import { Inject, Injectable, Logger, OnInit, OnShutdown } from "../core";
import { REDIS } from "./database.constants";

/**
 * Owns the lifecycle of the shared Redis client (the client itself has no onInit/onShutdown).
 * Features use `redis.client` directly: wrapping every Redis command would add nothing.
 */
@Injectable()
export class RedisService implements OnInit, OnShutdown {
  private readonly logger: Logger;

  constructor(
    @Inject(REDIS) readonly client: Redis,
    logger: Logger
  ) {
    this.logger = logger.child("Redis");
  }

  async onInit(): Promise<void> {
    // ioredis rejects with "Connection is closed." when the server refuses; say what failed.
    await this.client.connect().catch((error: Error) => {
      throw new Error(`Redis is unreachable at startup: ${error.message}`, { cause: error });
    });
    this.logger.info("Connected to Redis");
  }

  async onShutdown(): Promise<void> {
    if (this.client.status === "ready") {
      await this.client.quit(); // graceful: lets in-flight replies arrive
    } else {
      // Startup failed or the server is gone. QUIT would open a connection just to send it
      // (lazyConnect) or wait behind endless reconnect attempts; drop the socket and timers.
      this.client.disconnect();
    }
    this.logger.info("Redis connection closed");
  }
}
