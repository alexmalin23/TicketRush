import type { Request } from "express";
import { Controller, Delete, Get, Patch, Post, UseGuards, Validate } from "../../core";
import { Roles } from "../../common/decorators/roles.decorator";
import { AuthGuard } from "../../common/guards/auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import {
  IdParams,
  IdParamsSchema,
  PaginationQuery,
  PaginationQuerySchema,
} from "../../common/validators/common.schemas";
import { CreateProductInput, CreateProductSchema, UpdateProductInput, UpdateProductSchema } from "./products.schemas";
import { ProductsService } from "./products.service";

/**
 * HTTP layer only: read the (already validated) request, call the service, return the result.
 * Reading is public; writing requires an admin.
 *
 * The Request<Params, ResBody, Body, Query> generics only describe types;
 * @Validate is what makes them true at runtime.
 */
@Controller("/products")
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get("/")
  @Validate({ query: PaginationQuerySchema })
  findAll(req: Request<object, unknown, unknown, PaginationQuery>) {

    // return json 
    return { data: []};
    // return this.productsService.findAll(req.query);
  }

  @Get("/:id")
  @Validate({ params: IdParamsSchema })
  findOne(req: Request<IdParams>) {
    return this.productsService.findOne(req.params.id);
  }

  @Post("/") // 201 by default
  @UseGuards(AuthGuard, RolesGuard)
  @Roles("admin")
  @Validate({ body: CreateProductSchema })
  create(req: Request<object, unknown, CreateProductInput>) {
    return this.productsService.create(req.body);
  }

  @Patch("/:id")
  @UseGuards(AuthGuard, RolesGuard)
  @Roles("admin")
  @Validate({ params: IdParamsSchema, body: UpdateProductSchema })
  update(req: Request<IdParams, unknown, UpdateProductInput>) {
    return this.productsService.update(req.params.id, req.body);
  }

  @Delete("/:id") // returns nothing -> 204 No Content
  @UseGuards(AuthGuard, RolesGuard)
  @Roles("admin")
  @Validate({ params: IdParamsSchema })
  async remove(req: Request<IdParams>) {
    await this.productsService.remove(req.params.id);
  }
}
