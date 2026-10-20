import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException } from "../../core";
import { ENV, Env } from "../../config/env";

/**
 * Dev routes exist only with ENABLE_DEV_ROUTES=true. Otherwise they answer exactly like
 * an unknown route (same 404 and message), so a production deployment does not reveal them.
 */
@Injectable()
export class DevRoutesGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate({ req }: ExecutionContext): boolean {
    if (!this.env.ENABLE_DEV_ROUTES) {
      throw new NotFoundException(`Cannot ${req.method} ${req.path}`);
    }
    return true;
  }
}
