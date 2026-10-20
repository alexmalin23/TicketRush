import { z } from "zod";

// Trim + lowercase BEFORE checking the format, so "  Dan@Mail.com " and "dan@mail.com" are one account.
const email = z.string().trim().toLowerCase().pipe(z.email());

export const RegisterSchema = z.object({
  email,
  password: z.string().min(8).max(128),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email,
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;
