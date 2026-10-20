import type { Request } from "express";
import { Controller, Get, HttpCode, Post, UseGuards, Validate } from "../../core";
import { AuthGuard } from "../../common/guards/auth.guard";
import { UsersService } from "../users/users.service";
import { LoginInput, LoginSchema, RegisterInput, RegisterSchema } from "./auth.schemas";
import { AuthService } from "./auth.service";

@Controller("/auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService
  ) {}

  @Post("/register")
  @Validate({ body: RegisterSchema })
  register(req: Request<object, unknown, RegisterInput>) {
    return this.authService.register(req.body);
  }

  @Post("/login")
  @HttpCode(200) // logging in does not create a resource, so not 201
  @Validate({ body: LoginSchema })
  login(req: Request<object, unknown, LoginInput>) {
    return this.authService.login(req.body);
  }

  @Get("/me")
  @UseGuards(AuthGuard)
  me(req: Request) {
    // AuthGuard guarantees req.user. Read the user fresh from the DB, not from the token.
    return this.usersService.findById(req.user!.id);
  }
}
