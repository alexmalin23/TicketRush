import type { Request } from "express";
import { Controller, Get, HttpCode, Post, UseGuards, Validate } from "../../core";
import { API_PREFIX } from "../../common/api";
import { AuthGuard, bearerToken } from "../../common/guards/auth.guard";
import { UsersService } from "../users/users.service";
import { LoginInput, LoginSchema, RegisterInput, RegisterSchema } from "./auth.schemas";
import { AuthService } from "./auth.service";

@Controller(API_PREFIX)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService
  ) {}

  @Post("/auth/register")
  @Validate({ body: RegisterSchema })
  register(req: Request<object, unknown, RegisterInput>) {
    return this.authService.register(req.body);
  }

  @Post("/auth/login")
  @HttpCode(200) // logging in does not create a resource, so not 201
  @Validate({ body: LoginSchema })
  login(req: Request<object, unknown, LoginInput>) {
    return this.authService.login(req.body);
  }

  /** Revokes the current token. Other sessions of the same user (other tokens) stay valid. */
  @Post("/auth/logout")
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(req: Request) {
    await this.authService.logout(bearerToken(req)!); // AuthGuard guarantees a token
  }

  @Get("/me")
  @UseGuards(AuthGuard)
  async me(req: Request) {
    // AuthGuard guarantees req.user. Read the user fresh from the DB, not from the token.
    const { id, email } = await this.usersService.findById(req.user!.id);
    return { id, email };
  }
}
