import type { Request, Response } from "express";
import { Controller, Get, Post, UseGuards, Validate } from "../../core";
import { API_PREFIX } from "../../common/api";
import { AuthGuard } from "../../common/guards/auth.guard";
import { IDEMPOTENCY_KEY_HEADER, requireIdempotencyKey } from "../idempotency/idempotency.service";
import { CreateOrderInput, CreateOrderSchema, OrderIdParams, OrderIdParamsSchema } from "./orders.schemas";
import { OrdersService } from "./orders.service";

@Controller(`${API_PREFIX}/orders`)
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /** 201 paid, 402 declined, 202 payment outcome not known yet. A retry with the same key replays the same answer. */
  @Post("/")
  @Validate({ body: CreateOrderSchema })
  async create(req: Request<object, unknown, CreateOrderInput>, res: Response) {
    const key = requireIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER));
    const { status, body } = await this.ordersService.create(req.user!.id, key, req.body);
    res.status(status).json(body);
  }

  @Get("/")
  findMine(req: Request) {
    return this.ordersService.findMine(req.user!.id);
  }

  @Get("/:id")
  @Validate({ params: OrderIdParamsSchema })
  findOne(req: Request<OrderIdParams>) {
    return this.ordersService.findOne(req.params.id, req.user!.id);
  }
}
