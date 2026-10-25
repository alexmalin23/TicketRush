import { z } from "zod";
import type { FactoryProvider } from "../core";

/** DI token for the provider's validated settings. */
export const PROVIDER_CONFIG = "PROVIDER_CONFIG";

const rate = z.coerce.number().min(0).max(1);

const ProviderConfigSchema = z
  .object({
    PAYMENTS_PROVIDER_PORT: z.coerce.number().int().min(0).max(65535).default(3100),
    MOCK_PAYMENT_LATENCY_MS_MIN: z.coerce.number().int().min(0).default(300),
    MOCK_PAYMENT_LATENCY_MS_MAX: z.coerce.number().int().min(0).default(1500),
    /** Share of charges the issuer declines. */
    MOCK_PAYMENT_FAILURE_RATE: rate.default(0.1),
    /** Share of charges whose response is held back past any sane client timeout. */
    MOCK_PAYMENT_TIMEOUT_RATE: rate.default(0.02),
    MOCK_PAYMENT_HANG_MS: z.coerce.number().int().min(0).default(30_000),
  })
  .refine((c) => c.MOCK_PAYMENT_LATENCY_MS_MIN <= c.MOCK_PAYMENT_LATENCY_MS_MAX, "latency min must be <= max")
  .refine((c) => c.MOCK_PAYMENT_FAILURE_RATE + c.MOCK_PAYMENT_TIMEOUT_RATE <= 1, "failure + timeout rates must be <= 1");

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export function loadProviderConfig(source: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const result = ProviderConfigSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "config"}: ${i.message}`);
    throw new Error(`Invalid payments provider configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

export const providerConfigProvider: FactoryProvider = {
  provide: PROVIDER_CONFIG,
  useFactory: () => loadProviderConfig(),
};
