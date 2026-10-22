import type { Request } from "express";
import { Controller, Post, UseGuards, Validate } from "../../core";
import { API_PREFIX } from "../../common/api";
import { AuthGuard } from "../../common/guards/auth.guard";
import { IdParams, IdParamsSchema } from "../../common/validators/common.schemas";
import { CreateHoldInput, CreateHoldSchema } from "./holds.schemas";
import { HoldsService } from "./holds.service";

@Controller(`${API_PREFIX}/events`)
@UseGuards(AuthGuard)
export class HoldsController {
  constructor(private readonly holdsService: HoldsService) {}

  @Post("/:id/holds")
  @Validate({ params: IdParamsSchema, body: CreateHoldSchema })
  create(req: Request<IdParams, unknown, CreateHoldInput>) {
    return this.holdsService.hold(req.params.id, req.user!.id, req.body.seatIds);
  }
}
