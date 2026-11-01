import { randomUUID } from "node:crypto";
import jwt, { SignOptions } from "jsonwebtoken";
import { Inject, Injectable, UnauthorizedException } from "../../core";
import type { AuthUser, Role } from "../../common/types/auth-user";
import { ENV, Env } from "../../config/env";

interface TokenPayload {
  sub: string;
  email: string;
  role: Role;
  jti?: string;
  exp: number;
}

/** A token whose signature and expiry are valid. Whether it was revoked is TokenDenylist's call. */
export interface VerifiedToken {
  user: AuthUser;
  /** Unique per token: what logout revokes. */
  tokenId: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** Creates and verifies JWT access tokens. */
@Injectable()
export class TokenService {
  // Env is a type, not a class, so it needs an explicit token.
  constructor(@Inject(ENV) private readonly env: Env) {}

  sign(user: AuthUser): string {
    return jwt.sign({ email: user.email, role: user.role }, this.env.JWT_SECRET, {
      subject: String(user.id),
      jwtid: randomUUID(),
      expiresIn: this.env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
      algorithm: "HS256",
    });
  }

  verify(token: string): VerifiedToken {
    let payload: TokenPayload;
    try {
      // Pinning the algorithm blocks "alg: none" and algorithm-confusion attacks.
      payload = jwt.verify(token, this.env.JWT_SECRET, {
        algorithms: ["HS256"],
      }) as TokenPayload;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
    // A token without an id could never be revoked.
    if (!payload.jti) throw new UnauthorizedException("Invalid or expired token");
    return {
      user: { id: Number(payload.sub), email: payload.email, role: payload.role },
      tokenId: payload.jti,
      expiresAt: payload.exp,
    };
  }
}
