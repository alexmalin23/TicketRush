import jwt, { SignOptions } from "jsonwebtoken";
import { Inject, Injectable, UnauthorizedException } from "../../core";
import type { AuthUser, Role } from "../../common/types/auth-user";
import { ENV, Env } from "../../config/env";

interface TokenPayload {
  sub: string;
  email: string;
  role: Role;
}

/** Creates and verifies JWT access tokens. */
@Injectable()
export class TokenService {
  // Env is a type, not a class, so it needs an explicit token.
  constructor(@Inject(ENV) private readonly env: Env) {}

  sign(user: AuthUser): string {
    return jwt.sign({ email: user.email, role: user.role }, this.env.JWT_SECRET, {
      subject: String(user.id),
      expiresIn: this.env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
      algorithm: "HS256",
    });
  }

  verify(token: string): AuthUser {
    try {
      // Pinning the algorithm blocks "alg: none" and algorithm-confusion attacks.
      const payload = jwt.verify(token, this.env.JWT_SECRET, {
        algorithms: ["HS256"],
      }) as TokenPayload;
      return { id: Number(payload.sub), email: payload.email, role: payload.role };
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}
