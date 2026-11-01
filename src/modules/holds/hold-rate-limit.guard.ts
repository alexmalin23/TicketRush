import { randomUUID } from "node:crypto";
import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from "../../core";
import { ENV, Env } from "../../config/env";
import { RedisService } from "../../database/redis.service";

/**
 * Sliding log in one Redis sorted set per buyer: one member per allowed attempt, scored by time.
 * Runs as a single script, so no other replica's attempt can land between the count and the add:
 * with a separate ZCARD, check and ZADD, two replicas could both read limit - 1 and both add.
 * Time comes from Redis, not from each replica, so clock drift between machines cannot move the window.
 * Returns 0 when allowed, otherwise the milliseconds until the oldest attempt leaves the window.
 */
const SLIDING_LOG = `
local now = redis.call('TIME')
local nowMs = now[1] * 1000 + math.floor(now[2] / 1000)
local windowMs = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, nowMs - windowMs)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], nowMs, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], windowMs)
  return 0
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return tonumber(oldest[2]) + windowMs - nowMs
`;

interface Window {
  startedAt: number;
  attempts: number;
}

/**
 * Caps hold attempts per buyer: HOLD_RATE_LIMIT per HOLD_RATE_WINDOW_SECONDS, then 429.
 * Every attempt that reaches the hold logic counts, successful or not: a bot cycling through
 * seats is the target.
 *
 * RATE_LIMIT_STORE=redis counts in Redis, so the limit holds for the whole system whatever the
 * number of replicas. RATE_LIMIT_STORE=memory is the benchmark baseline: a fixed window in this
 * process's memory, where each replica counts alone (limit x replicas behind a load balancer).
 */
@Injectable()
export class HoldRateLimitGuard implements CanActivate {
  // Memory store only. One entry per buyer seen; never pruned, gone on restart.
  private readonly windows = new Map<number, Window>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redis: RedisService
  ) {}

  async canActivate({ req, res }: ExecutionContext): Promise<boolean> {
    const userId = req.user!.id;
    const waitMs = this.env.RATE_LIMIT_STORE === "redis" ? await this.attemptInRedis(userId) : this.attemptInMemory(userId);
    if (waitMs === 0) return true;

    const retryAfterSeconds = Math.ceil(waitMs / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    throw new HttpException(429, "Too many hold attempts, retry later", { retryAfterSeconds }, "RATE_LIMITED");
  }

  /** Milliseconds to wait, 0 when allowed. */
  private async attemptInRedis(userId: number): Promise<number> {
    const windowMs = this.env.HOLD_RATE_WINDOW_SECONDS * 1000;
    // EVAL resends the script each time; at hold rates (a few per buyer per minute) caching it
    // with EVALSHA would save bytes, not time.
    const waitMs = await this.redis.client.eval(SLIDING_LOG, 1, `rate-limit:hold:${userId}`, windowMs, this.env.HOLD_RATE_LIMIT, randomUUID());
    return Number(waitMs);
  }

  private attemptInMemory(userId: number): number {
    const now = Date.now();
    const windowMs = this.env.HOLD_RATE_WINDOW_SECONDS * 1000;
    let window = this.windows.get(userId);
    if (!window || now - window.startedAt >= windowMs) {
      window = { startedAt: now, attempts: 0 };
      this.windows.set(userId, window);
    }
    window.attempts++;
    return window.attempts <= this.env.HOLD_RATE_LIMIT ? 0 : window.startedAt + windowMs - now;
  }
}
