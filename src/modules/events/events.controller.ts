import type { Request } from "express";
import { Controller, Get, Validate } from "../../core";
import { API_PREFIX } from "../../common/api";
import { IdParams, IdParamsSchema } from "../../common/validators/common.schemas";
import { SeatMapQuery, SeatMapQuerySchema } from "./events.schemas";
import { EventsService } from "./events.service";

/** Public browsing: no login needed to look at events and seats. */
@Controller(`${API_PREFIX}/events`)
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get("/")
  findAll() {
    return this.eventsService.findAll();
  }

  @Get("/:id")
  @Validate({ params: IdParamsSchema })
  findOne(req: Request<IdParams>) {
    return this.eventsService.findOne(req.params.id);
  }

  @Get("/:id/availability")
  @Validate({ params: IdParamsSchema })
  availability(req: Request<IdParams>) {
    return this.eventsService.availability(req.params.id);
  }

  @Get("/:id/seats")
  @Validate({ params: IdParamsSchema, query: SeatMapQuerySchema })
  seatMap(req: Request<IdParams, unknown, unknown, SeatMapQuery>) {
    return this.eventsService.seatMap(req.params.id, req.query.section);
  }
}
