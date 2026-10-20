import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "../../core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import type { Role } from "../types/auth-user";

/**
 * Authorization: checks req.user.role against @Roles(...).
 * Must run AFTER AuthGuard: @UseGuards(AuthGuard, RolesGuard).
 * Returning false makes the framework respond 403.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const required = context.getMetadata<Role[]>(ROLES_KEY);
    if (!required || required.length === 0) return true;

    const user = context.req.user;
    if (!user) {
      throw new UnauthorizedException("Not authenticated (did you add AuthGuard before RolesGuard?)");
    }
    return required.includes(user.role);
  }
}
