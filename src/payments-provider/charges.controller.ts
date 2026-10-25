import type { Request } from "express";
import { BadRequestException, Controller, Delete, Get, HttpCode, Post, Validate } from "../core";
import { CreateChargeInput, CreateChargeSchema, MOCK_OUTCOME_HEADER, MockOutcomeSchema } from "./charges.schemas";
import { ChargesService } from "./charges.service";

@Controller()
export class ChargesController {
  constructor(private readonly charges: ChargesService) {}

  @Get("/health")
  health() {
    return { status: "ok" };
  }

  @Post("/charges")
  @HttpCode(200) // replays return the same charge; 201 would claim something new was created
  @Validate({ body: CreateChargeSchema })
  charge(req: Request<object, unknown, CreateChargeInput>) {
    const header = req.get(MOCK_OUTCOME_HEADER);
    const forced = header === undefined ? undefined : MockOutcomeSchema.safeParse(header);
    if (forced && !forced.success) throw new BadRequestException(`Unknown ${MOCK_OUTCOME_HEADER}: ${header}`);
    return this.charges.charge(req.body, forced?.data);
  }

  /** Audit trail: every decided charge, for "zero double charges" checks in tests and load runs. */
  @Get("/ledger")
  ledger() {
    const charges = this.charges.ledgerEntries();
    return {
      charges,
      totals: {
        charges: charges.length,
        succeeded: charges.filter((c) => c.status === "succeeded").length,
        declined: charges.filter((c) => c.status === "declined").length,
        capturedCents: charges.filter((c) => c.status === "succeeded").reduce((sum, c) => sum + c.amountCents, 0),
      },
    };
  }

  @Delete("/ledger")
  reset() {
    this.charges.reset();
  }
}
