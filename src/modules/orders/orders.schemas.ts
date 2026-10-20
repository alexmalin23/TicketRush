import { z } from "zod";

export const CreateOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        quantity: z.number().int().min(1).max(1000),
      })
    )
    .min(1)
    .max(50)
    .refine(
      (items) => new Set(items.map((item) => item.productId)).size === items.length,
      "Each product may appear only once"
    ),
});
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
