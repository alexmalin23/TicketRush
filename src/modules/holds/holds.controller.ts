import type { Request } from "express";
import { Controller, Delete, Get, HttpCode, Post, UseGuards, Validate } from "../../core";
import { API_PREFIX } from "../../common/api";
import { AuthGuard } from "../../common/guards/auth.guard";
import { IdParams, IdParamsSchema } from "../../common/validators/common.schemas";
import { AccessTokenGuard } from "../waiting-room/access-token.guard";
import { CreateHoldInput, CreateHoldSchema, ReleaseHoldsInput, ReleaseHoldsSchema } from "./holds.schemas";
import { HoldRateLimitGuard } from "./hold-rate-limit.guard";
import { HoldsService } from "./holds.service";

@Controller(`${API_PREFIX}/events`)
@UseGuards(AuthGuard)
export class HoldsController {
  constructor(private readonly holdsService: HoldsService) {}

  @Post("/:id/holds")
  @UseGuards(AccessTokenGuard, HoldRateLimitGuard) // after AuthGuard (class guards run first): need req.user
  @Validate({ params: IdParamsSchema, body: CreateHoldSchema })
  create(req: Request<IdParams, unknown, CreateHoldInput>) {
    return this.holdsService.hold(req.params.id, req.user!.id, req.body.seatIds);
  }

  @Get("/:id/holds/me")
  @Validate({ params: IdParamsSchema })
  mine(req: Request<IdParams>) {
    return this.holdsService.myHolds(req.params.id, req.user!.id);
  }

  @Delete("/:id/holds/me")
  @HttpCode(204)
  @Validate({ params: IdParamsSchema, body: ReleaseHoldsSchema })
  async release(req: Request<IdParams, unknown, ReleaseHoldsInput>) {
    await this.holdsService.release(req.params.id, req.user!.id, req.body.seatIds ?? null);
  }
}
