import { currentRequestId } from "../http/request-context";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "text" | "json";

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

/** "json" for machines (one object per line), anything else falls back to readable text. */
export function parseLogFormat(value: string | undefined): LogFormat {
  return value === "json" ? "json" : "text";
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const serializeError = (error: Error) => ({ name: error.name, message: error.message, stack: error.stack });

/**
 * A tiny leveled logger.
 * `child("Orders")` returns a logger with the same level and format that prefixes lines with [Orders].
 * It is registered in the DI container, so any provider can inject it by type.
 *
 * Inside a request every line carries its request id automatically (from the request context),
 * so one request can be followed through hundreds of concurrent ones.
 * - text: `2026-10-21T10:00:00.000Z INFO  [Orders] (3f2a9c1e) message`
 * - json: `{"time":"...","level":"info","context":"Orders","requestId":"...","msg":"message"}`
 *   Plain objects passed as meta become fields; Errors become {name, message, stack}.
 */
export class Logger {
  constructor(
    readonly level: LogLevel = "info",
    private readonly context?: string,
    readonly format: LogFormat = "text"
  ) {}

  child(context: string): Logger {
    return new Logger(this.level, context, this.format);
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

    const sink =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    const requestId = currentRequestId();

    if (this.format === "json") {
      const entry: Record<string, unknown> = {
        time: new Date().toISOString(),
        level,
        ...(this.context ? { context: this.context } : {}),
        ...(requestId ? { requestId } : {}),
        msg: message,
      };
      const extra: unknown[] = [];
      for (const item of meta) {
        if (item instanceof Error) entry.error = serializeError(item);
        else if (isPlainObject(item)) Object.assign(entry, item);
        else extra.push(item);
      }
      if (extra.length > 0) entry.meta = extra;
      sink(JSON.stringify(entry));
      return;
    }

    const context = this.context ? `[${this.context}] ` : "";
    const id = requestId ? `(${requestId.slice(0, 8)}) ` : "";
    sink(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${context}${id}${message}`, ...meta);
  }
}
