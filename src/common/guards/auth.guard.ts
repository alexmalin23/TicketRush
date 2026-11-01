import type { Request } from "express";
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "../../core";
import { TokenDenylist } from "../../modules/auth/token-denylist";
import { TokenService } from "../../modules/auth/token.service";
import type {} from "../types/auth-user";

/** The token from "Authorization: Bearer <jwt>", or undefined. */
export function bearerToken(req: Request): string | undefined {
  const [scheme, token] = req.headers.authorization?.split(" ") ?? [];
  return scheme === "Bearer" && token ? token : undefined;
}

/**
 * Authentication: requires "Authorization: Bearer <jwt>" that is validly signed, unexpired and
 * not revoked. On success it puts the decoded user on req.user for the next guards and the handler.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly denylist: TokenDenylist
  ) {}

  async canActivate({ req }: ExecutionContext): Promise<boolean> {
    const token = bearerToken(req);
    if (!token) throw new UnauthorizedException("Missing bearer token");

    const verified = this.tokens.verify(token); // throws 401 if invalid or expired
    // The signature cannot say "logged out": that fact lives in Redis, shared by every replica.
    if (await this.denylist.has(verified.tokenId)) {
      throw new UnauthorizedException("Token has been revoked");
    }
    req.user = verified.user;
    return true;
  }
}
