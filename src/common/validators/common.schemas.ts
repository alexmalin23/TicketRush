import { z } from "zod";

/** "/:id" in the URL arrives as a string; this turns it into a positive integer or a 400. */
export const IdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export type IdParams = z.infer<typeof IdParamsSchema>;

/** ?limit=20&offset=40 */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
