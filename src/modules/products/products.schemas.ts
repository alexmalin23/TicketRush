import { z } from "zod";

const name = z.string().trim().min(1).max(200);
const price = z.number().nonnegative().max(1_000_000);
const stock = z.number().int().nonnegative();

export const CreateProductSchema = z.object({
  name,
  price,
  stock: stock.default(0),
});
export type CreateProductInput = z.infer<typeof CreateProductSchema>;

// Separate object without defaults: on PATCH a missing field must stay missing,
// not be reset to its default value.
export const UpdateProductSchema = z
  .object({ name, price, stock })
  .partial()
  .refine((data) => Object.keys(data).length > 0, "At least one field is required");
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
