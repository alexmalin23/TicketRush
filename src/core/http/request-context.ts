import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export const REQUEST_ID_HEADER = "x-request-id";

/** Accept a caller's id (load balancer, client) only if it is short and log-safe. */
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * The id of the request currently being handled, from anywhere in its async call chain
 * (services, models, the logger) without passing it as a parameter. Undefined outside a request.
 */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * First middleware: assigns the request id (the caller's X-Request-Id if valid, else a UUID),
 * echoes it in the response header, and runs the rest of the request inside its context.
 */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const requestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    storage.run({ requestId }, next);
  };
}
