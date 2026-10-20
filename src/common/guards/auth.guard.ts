import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "../../core";
import { TokenService } from "../../modules/auth/token.service";
import type {} from "../types/auth-user";

/**
 * Authentication: requires "Authorization: Bearer <jwt>".
 * On success it puts the decoded user on req.user for the next guards and the handler.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  canActivate({ req }: ExecutionContext): boolean {
    const [scheme, token] = req.headers.authorization?.split(" ") ?? [];
    if (scheme !== "Bearer" || !token) {
      throw new UnauthorizedException("Missing bearer token");
    }
    req.user = this.tokens.verify(token); // throws 401 if invalid or expired
    return true;
  }
}
