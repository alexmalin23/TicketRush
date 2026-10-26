import { z } from "zod";

export const CreateOrderSchema = z.object({
  eventId: z.number().int().positive(),
  seatIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(6)
    .refine((ids) => new Set(ids).size === ids.length, "Each seat may appear only once"),
});
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

export const OrderIdParamsSchema = z.object({ id: z.uuid() });
export type OrderIdParams = z.infer<typeof OrderIdParamsSchema>;
