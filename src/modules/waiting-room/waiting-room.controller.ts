import type { Request, Response } from "express";
import { Controller, Get, Post, UseGuards, Validate } from "../../core";
import { API_PREFIX } from "../../common/api";
import { AuthGuard } from "../../common/guards/auth.guard";
import { IdParams, IdParamsSchema } from "../../common/validators/common.schemas";
import { WaitingRoomService } from "./waiting-room.service";

@Controller(`${API_PREFIX}/events`)
@UseGuards(AuthGuard)
export class WaitingRoomController {
  constructor(private readonly waitingRoom: WaitingRoomService) {}

  @Post("/:id/queue")
  @Validate({ params: IdParamsSchema })
  async join(req: Request<IdParams>, res: Response) {
    res.status(200).json(await this.waitingRoom.join(req.params.id, req.user!.id));
  }

  @Get("/:id/queue")
  @Validate({ params: IdParamsSchema })
  status(req: Request<IdParams>) {
    return this.waitingRoom.status(req.params.id, req.user!.id);
  }
}
