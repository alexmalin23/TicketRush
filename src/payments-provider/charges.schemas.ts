import { z } from "zod";

export const CreateChargeSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(255),
  amountCents: z.number().int().positive(),
});
export type CreateChargeInput = z.infer<typeof CreateChargeSchema>;

/** Test-only override of the random outcome, like a payment provider's test card numbers. */
export const MOCK_OUTCOME_HEADER = "mock-outcome";
export const MockOutcomeSchema = z.enum(["succeed", "decline", "hang"]);
export type MockOutcome = z.infer<typeof MockOutcomeSchema>;
