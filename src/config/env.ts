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
  /** A streaming replica of DATABASE_URL. Empty = none. */
  DATABASE_REPLICA_URL: z.string().optional().transform((url) => url || undefined),
  /** Where reads that tolerate replication lag go: "primary" (benchmark baseline) or "replica". */
  READ_ROUTING: z.enum(["primary", "replica"]).default("primary"),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("1h"),

  /** "*" or a comma separated list of allowed origins */
  CORS_ORIGIN: z.string().default("*"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /** "json" in containers (one object per line, with requestId); "text" for local reading */
  LOG_FORMAT: z.enum(["text", "json"]).default("text"),

  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  /** Where holds live: "postgres" (seat rows, the stage 1 baseline) or "redis" (keys with a TTL). */
  HOLD_STORE: z.enum(["postgres", "redis"]).default("postgres"),
  /** Where hold attempts are counted: "redis" (shared by every replica) or "memory" (per process, benchmark baseline). */
  RATE_LIMIT_STORE: z.enum(["memory", "redis"]).default("redis"),
  /** Hold attempts one buyer may make per window, then 429. */
  HOLD_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  HOLD_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),

  /** The card processor (a mock provider in this project, see src/payments-provider). */
  PAYMENTS_PROVIDER_URL: z.url().default("http://localhost:3100"),
  /** How long a charge may take before its outcome is treated as unknown. */
  PAYMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  /** How often each replica looks for orders left pending_payment by a crash or a timeout. 0 = never. */
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(5),
  /** An order pending this long has no request working on it anymore (3 charge attempts take ~9 s). */
  RECONCILE_AFTER_SECONDS: z.coerce.number().int().positive().default(30),

  /** Serve read paths from Redis. false = every read goes to Postgres (benchmark baseline). */
  CACHE_ENABLED: z.stringbool().default(false),
  /** How long browsing can show an event's old details; hold and order checks always read Postgres. */
  EVENT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /** Exposes /api/v1/dev/* (event reset between load runs). Never enable in production. */
  ENABLE_DEV_ROUTES: z.stringbool().default(false),
}).refine((env) => env.READ_ROUTING === "primary" || env.DATABASE_REPLICA_URL, {
  path: ["DATABASE_REPLICA_URL"],
  message: "required when READ_ROUTING=replica",
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
