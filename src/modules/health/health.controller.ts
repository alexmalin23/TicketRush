import { Controller, Get, ServiceUnavailableException } from "../../core";
import { HealthService } from "./health.service";

/**
 * Infrastructure probes, outside /api/v1 by convention (load balancer, Docker, Prometheus).
 * - /health: liveness. The process answers; no dependency checks, so a database outage
 *   never makes the orchestrator restart healthy API instances.
 * - /ready: readiness. Postgres and Redis reachable, otherwise 503 and traffic goes elsewhere.
 */
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("/health")
  health() {
    return { status: "ok" };
  }

  @Get("/ready")
  async ready() {
    const report = await this.healthService.readiness();
    if (!report.ready) {
      throw new ServiceUnavailableException("Service not ready", report.checks);
    }
    return { status: "ready", checks: report.checks };
  }
}
