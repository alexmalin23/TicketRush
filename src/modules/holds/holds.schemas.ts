import { z } from "zod";

export const CreateHoldSchema = z.object({
  seatIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(6)
    .refine((ids) => new Set(ids).size === ids.length, "Each seat may appear only once"),
});
export type CreateHoldInput = z.infer<typeof CreateHoldSchema>;
