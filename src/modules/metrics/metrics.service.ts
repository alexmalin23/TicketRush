import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { Inject, Injectable } from "../../core";
import { PG_POOL } from "../../database/database.constants";
import { RedisService } from "../../database/redis.service";
import { PaymentQueue } from "../orders/payment-queue";
import { waitingRoomKeys } from "../waiting-room/waiting-room.service";

/** One registry per application: tests start many, and prom-client's global one would mix them. */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** Labelled by route pattern, never by URL: an id per label value would grow without bound. */
  private readonly requests = new Histogram({
    name: "http_request_duration_seconds",
    help: "Request duration by route",
    labelNames: ["method", "route", "status"],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly seatCache = new Counter({
    name: "seat_cache_requests_total",
    help: "Seat cache answers by result: fresh, stale or miss",
    labelNames: ["result"],
    registers: [this.registry],
  });

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly redis: RedisService,
    private readonly paymentQueue: PaymentQueue
  ) {
    collectDefaultMetrics({ register: this.registry });
    this.gauges();
  }

  countSeatCache(result: "fresh" | "stale" | "miss"): void {
    this.seatCache.inc({ result });
  }

  /** Global middleware. The route is known only after routing, so it is read when the response ends. */
  readonly middleware = (req: Request, res: Response, next: NextFunction): void => {
    const stop = this.requests.startTimer();
    res.on("finish", () => {
      const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : "unmatched";
      if (route !== "/metrics") stop({ method: req.method, route, status: res.statusCode });
    });
    next();
  };

  /** Read when Prometheus asks, so an idle system costs nothing. A failed read must not lose the rest. */
  private gauges(): void {
    const { pool, redis, paymentQueue } = this;
    new Gauge({
      name: "db_pool_connections",
      help: "Postgres pool of this replica: total, idle, and requests waiting for a connection",
      labelNames: ["state"],
      registers: [this.registry],
      collect() {
        this.set({ state: "total" }, pool.totalCount);
        this.set({ state: "idle" }, pool.idleCount);
        this.set({ state: "waiting" }, pool.waitingCount);
      },
    });
    new Gauge({
      name: "payment_queue_jobs",
      help: "Payment jobs by state; dead = out of attempts",
      labelNames: ["state"],
      registers: [this.registry],
      async collect() {
        const counts = await paymentQueue.counts().catch(() => ({}));
        for (const [state, jobs] of Object.entries(counts)) this.set({ state }, jobs as number);
      },
    });
    new Gauge({
      name: "waiting_room_buyers",
      help: "Buyers per event, in line or admitted",
      labelNames: ["event", "state"],
      registers: [this.registry],
      async collect() {
        const events = await redis.client.smembers(waitingRoomKeys.events).catch(() => [] as string[]);
        for (const event of events) {
          const id = Number(event);
          const [line, admitted] = await Promise.all([
            redis.client.zcard(waitingRoomKeys.line(id)),
            redis.client.zcard(waitingRoomKeys.admitted(id)),
          ]).catch(() => [0, 0]);
          this.set({ event, state: "line" }, line);
          this.set({ event, state: "admitted" }, admitted);
        }
      },
    });
  }
}
