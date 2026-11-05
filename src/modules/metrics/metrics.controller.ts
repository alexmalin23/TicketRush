import type { Request, Response } from "express";
import { Controller, Get } from "../../core";
import { MetricsService } from "./metrics.service";

/** Outside /api/v1 like the health probes. nginx does not expose it: Prometheus scrapes each replica. */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get("/metrics")
  async scrape(_req: Request, res: Response) {
    res.type(this.metrics.registry.contentType).send(await this.metrics.registry.metrics());
  }
}
