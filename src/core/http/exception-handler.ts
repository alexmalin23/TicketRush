import { STATUS_CODES } from "node:http";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { defaultErrorCode, HttpException, NotFoundException } from "../exceptions/http-exceptions";
import { Logger } from "../logger/logger";
import { REQUEST_ID_HEADER } from "./request-context";

/** The single error format every failed request returns. */
export interface ErrorBody {
  statusCode: number;
  error: string;
  /** Machine-readable, stable: clients branch on this, never on `message`. */
  code: string;
  message: string;
  details?: unknown;
  /** Same id as the X-Request-Id header and every log line of the request. */
  requestId?: string;
}

/** PostgreSQL error codes that are really client errors, not server bugs. */
const PG_ERRORS: Record<string, { statusCode: number; message: string }> = {
  "23505": { statusCode: 409, message: "Resource already exists" }, // unique_violation
  "23503": { statusCode: 409, message: "Resource is referenced by other records" }, // foreign_key_violation
};

/** Message pg throws when no connection frees up within connectionTimeoutMillis. */
const POOL_TIMEOUT = "timeout exceeded when trying to connect";

function body(statusCode: number, message: string, details?: unknown, code?: string): ErrorBody {
  return {
    statusCode,
    error: STATUS_CODES[statusCode] ?? "Error",
    code: code ?? defaultErrorCode(statusCode),
    message,
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * Maps any thrown value to a response body.
 * Unknown errors become a generic 500: internal messages and stack traces
 * are logged on the server and never sent to the client.
 */
export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof HttpException) {
    return body(error.statusCode, error.message, error.details, error.code);
  }

  const e = (error ?? {}) as { type?: string; code?: string; message?: string };

  // Errors raised by express.json()
  if (e.type === "entity.parse.failed") return body(400, "Malformed JSON body");
  if (e.type === "entity.too.large") return body(413, "Request body is too large");

  // Database errors that the client caused (duplicates, references)
  if (e.code && PG_ERRORS[e.code]) {
    const mapped = PG_ERRORS[e.code];
    return body(mapped.statusCode, mapped.message);
  }

  // Pool exhaustion: every connection is busy. Tell the client to retry instead of hanging.
  if (typeof e.message === "string" && e.message.includes(POOL_TIMEOUT)) {
    return body(503, "Service temporarily unavailable, please retry");
  }

  return body(500, "Internal server error");
}

/** Registered after all routes: any request that reached here matched nothing. */
export function notFoundHandler(): RequestHandler {
  return (req) => {
    throw new NotFoundException(`Cannot ${req.method} ${req.path}`);
  };
}

/**
 * The global exception handler (Express recognizes it by its 4 arguments).
 * In Express 5, errors thrown inside async handlers arrive here automatically.
 */
export function exceptionHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, next) => {
    // The response is already streaming; let Express close the connection.
    if (res.headersSent) return next(error);

    // Read from the response header, not the async context: the request id must survive
    // even errors raised before or outside it (e.g. the JSON body parser).
    const requestId = res.getHeader(REQUEST_ID_HEADER) as string | undefined;
    const response = { ...toErrorBody(error), requestId };
    if (response.statusCode >= 500) {
      logger.error(`${req.method} ${req.originalUrl} failed`, error);
    }
    res.status(response.statusCode).json(response);
  };
}
