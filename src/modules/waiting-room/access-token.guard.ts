import { CanActivate, ExecutionContext, Inject, Injectable } from "../../core";
import { ENV, Env } from "../../config/env";
import { WaitingRoomService } from "./waiting-room.service";

export const ACCESS_TOKEN_HEADER = "x-access-token";

/** Runs after AuthGuard: an access token belongs to one buyer and one event. */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly waitingRoom: WaitingRoomService
  ) {}

  canActivate({ req }: ExecutionContext): boolean {
    if (!this.env.WAITING_ROOM_ENABLED) return true;
    this.waitingRoom.assertAccess(req.get(ACCESS_TOKEN_HEADER), Number(req.params.id), req.user!.id);
    return true;
  }
}
