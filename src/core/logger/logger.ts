export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Turns any string into a valid level, falling back to "info". */
export function parseLogLevel(value: string | undefined): LogLevel {
  return value && value in LEVEL_ORDER ? (value as LogLevel) : "info";
}

/**
 * A tiny leveled logger.
 * `child("Orders")` returns a logger with the same level that prefixes lines with [Orders].
 * It is registered in the DI container, so any provider can inject it by type.
 */
export class Logger {
  constructor(
    readonly level: LogLevel = "info",
    private readonly context?: string
  ) {}

  child(context: string): Logger {
    return new Logger(this.level, context);
  }

  debug(message: string, ...meta: unknown[]): void {
    this.write("debug", message, meta);
  }

  info(message: string, ...meta: unknown[]): void {
    this.write("info", message, meta);
  }

  warn(message: string, ...meta: unknown[]): void {
    this.write("warn", message, meta);
  }

  error(message: string, ...meta: unknown[]): void {
    this.write("error", message, meta);
  }

  private write(level: Exclude<LogLevel, "silent">, message: string, meta: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const context = this.context ? `[${this.context}] ` : "";
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${context}${message}`;

    const sink =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    sink(line, ...meta);
  }
}
