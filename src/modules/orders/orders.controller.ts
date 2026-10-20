import type { Request } from "express";
import { Controller, Get, Post, UseGuards, Validate } from "../../core";
import { AuthGuard } from "../../common/guards/auth.guard";
import { IdParams, IdParamsSchema } from "../../common/validators/common.schemas";
import { CreateOrderInput, CreateOrderSchema } from "./orders.schemas";
import { OrdersService } from "./orders.service";

/** Every route needs a logged-in user (class-level guard). */
@Controller("/orders")
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post("/")
  @Validate({ body: CreateOrderSchema })
  create(req: Request<object, unknown, CreateOrderInput>) {
    return this.ordersService.create(req.user!.id, req.body);
  }

  @Get("/")
  findMine(req: Request) {
    return this.ordersService.findMine(req.user!.id);
  }

  @Get("/:id")
  @Validate({ params: IdParamsSchema })
  findOne(req: Request<IdParams>) {
    return this.ordersService.findOne(req.params.id, req.user!);
  }
}
