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
      throw new Error(`Redis is unreachable at startup: ${error.message}`);
    });
    this.logger.info("Connected to Redis");
  }

  async onShutdown(): Promise<void> {
    await this.client.quit();
    this.logger.info("Redis connection closed");
  }
}
