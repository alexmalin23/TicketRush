import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from "../../core";
import { ENV, Env } from "../../config/env";

interface Window {
  startedAt: number;
  attempts: number;
}

/**
 * Caps hold attempts per buyer: HOLD_RATE_LIMIT per HOLD_RATE_WINDOW_SECONDS, then 429.
 * Every attempt counts, successful or not: a bot cycling through seats is the target.
 *
 * Fixed window, counted in this process's memory. Each API replica keeps its own counts,
 * so behind a load balancer a buyer gets up to (limit x replicas) attempts per window.
 * A shared store (Redis) is the fix once more than one replica runs.
 */
@Injectable()
export class HoldRateLimitGuard implements CanActivate {
  // One entry per buyer seen; never pruned. Small next to the users table, and gone on restart.
  private readonly windows = new Map<number, Window>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate({ req, res }: ExecutionContext): boolean {
    const now = Date.now();
    const windowMs = this.env.HOLD_RATE_WINDOW_SECONDS * 1000;
    let window = this.windows.get(req.user!.id);
    if (!window || now - window.startedAt >= windowMs) {
      window = { startedAt: now, attempts: 0 };
      this.windows.set(req.user!.id, window);
    }

    window.attempts++;
    if (window.attempts <= this.env.HOLD_RATE_LIMIT) return true;

    const retryAfterSeconds = Math.ceil((window.startedAt + windowMs - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    throw new HttpException(429, "Too many hold attempts, retry later", { retryAfterSeconds }, "RATE_LIMITED");
  }
}
