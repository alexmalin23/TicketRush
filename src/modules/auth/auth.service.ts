import { ConflictException, Injectable, UnauthorizedException } from "../../core";
import { UsersModel } from "../users/users.model";
import { LoginInput, RegisterInput } from "./auth.schemas";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./password";
import { TokenDenylist } from "./token-denylist";
import { TokenService } from "./token.service";

/** What register and login return: the account and a bearer token for the next requests. */
export interface AuthResult {
  id: number;
  email: string;
  accessToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersModel: UsersModel,
    private readonly tokens: TokenService,
    private readonly denylist: TokenDenylist
  ) {}

  async register(input: RegisterInput): Promise<AuthResult> {
    // A friendly check. If two requests race past it, the UNIQUE constraint
    // still rejects the second one and the exception handler maps it to 409.
    if (await this.usersModel.findByEmailWithPassword(input.email)) {
      throw new ConflictException("Email is already registered");
    }

    const user = await this.usersModel.create({
      email: input.email,
      passwordHash: await hashPassword(input.password),
    });
    return { id: user.id, email: user.email, accessToken: this.tokens.sign(user) };
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const record = await this.usersModel.findByEmailWithPassword(input.email);
    const valid = await verifyPassword(input.password, record?.passwordHash ?? DUMMY_HASH);

    // Same message for both cases: do not reveal which emails exist.
    if (!record || !valid) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const { passwordHash: _hash, ...user } = record;
    return { id: user.id, email: user.email, accessToken: this.tokens.sign(user) };
  }

  /** Revokes this token on every replica until it would have expired. */
  async logout(token: string): Promise<void> {
    const { tokenId, expiresAt } = this.tokens.verify(token);
    await this.denylist.add(tokenId, expiresAt);
  }
}
