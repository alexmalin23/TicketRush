import type { Request } from "express";
import { Controller, Get, HttpCode, Post, UseGuards, Validate } from "../../core";
import { API_PREFIX } from "../../common/api";
import { IdParams, IdParamsSchema } from "../../common/validators/common.schemas";
import { DevRoutesGuard } from "./dev-routes.guard";
import { DevService } from "./dev.service";
import { InvariantsService } from "./invariants.service";

/** Tooling for load runs. Disabled unless ENABLE_DEV_ROUTES=true. */
@Controller(`${API_PREFIX}/dev`)
@UseGuards(DevRoutesGuard)
export class DevController {
  constructor(
    private readonly devService: DevService,
    private readonly invariants: InvariantsService
  ) {}

  @Post("/events/:id/reset")
  @HttpCode(200) // resets state, creates nothing
  @Validate({ params: IdParamsSchema })
  resetEvent(req: Request<IdParams>) {
    return this.devService.resetEvent(req.params.id);
  }

  /** The correctness checks every buying scenario ends with: database cross-checked against the provider ledger. */
  @Get("/events/:id/invariants")
  @Validate({ params: IdParamsSchema })
  checkInvariants(req: Request<IdParams>) {
    return this.invariants.check(req.params.id);
  }
}
