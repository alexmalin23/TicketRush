import { z } from "zod";

export const SeatMapQuerySchema = z.object({
  section: z.string().trim().min(1).max(16),
});
export type SeatMapQuery = z.infer<typeof SeatMapQuerySchema>;
