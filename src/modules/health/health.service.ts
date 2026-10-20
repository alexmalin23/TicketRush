import { Injectable } from "../../core";
import { DatabaseService } from "../../database/database.service";
import { RedisService } from "../../database/redis.service";

export type CheckStatus = "up" | "down";

export interface ReadinessReport {
  ready: boolean;
  checks: { postgres: CheckStatus; redis: CheckStatus };
}

/** A probe must answer fast even when a dependency hangs, or the load balancer waits on it. */
const CHECK_TIMEOUT_MS = 1000;

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [postgres, redis] = await Promise.all([
      check(() => this.database.query("SELECT 1")),
      check(() => this.redis.client.ping()),
    ]);
    return { ready: postgres === "up" && redis === "up", checks: { postgres, redis } };
  }
}
