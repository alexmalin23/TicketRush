import type { Request } from "express";
import { Controller, Get, UseGuards, Validate } from "../../core";
import { Roles } from "../../common/decorators/roles.decorator";
import { AuthGuard } from "../../common/guards/auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { IdParams, IdParamsSchema } from "../../common/validators/common.schemas";
import { UsersService } from "./users.service";

/** Admin-only: the guards and @Roles on the class apply to every route below. */
@Controller("/users")
@UseGuards(AuthGuard, RolesGuard)
@Roles("admin")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("/")
  findAll() {
    return this.usersService.findAll();
  }

  @Get("/:id")
  @Validate({ params: IdParamsSchema })
  findOne(req: Request<IdParams>) {
    return this.usersService.findById(req.params.id);
  }
}
