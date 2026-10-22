import { existsSync } from "node:fs";
import { z } from "zod";
import type { FactoryProvider } from "../core";

/** DI token for the validated environment: constructor(@Inject(ENV) env: Env) */
export const ENV = "ENV";

/**
 * Every environment variable the app uses, validated once at startup.
 * A missing or invalid value stops the app immediately with a clear message,
 * instead of failing later in some random request.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("1h"),

  /** "*" or a comma separated list of allowed origins */
  CORS_ORIGIN: z.string().default("*"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /** "json" in containers (one object per line, with requestId); "text" for local reading */
  LOG_FORMAT: z.enum(["text", "json"]).default("text"),

  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  /** Exposes /api/v1/dev/* (event reset between load runs). Never enable in production. */
  ENABLE_DEV_ROUTES: z.stringbool().default(false),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`
    );
    throw new Error(`Invalid environment variables:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Registers the validated environment under the ENV token (listed in app.ts). */
export const envProvider: FactoryProvider = {
  provide: ENV,
  useFactory: () => loadEnv(),
};

/** Loads ./.env into process.env (built into Node 20.12+). Existing variables are not overwritten. */
export function loadDotEnvFile(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
