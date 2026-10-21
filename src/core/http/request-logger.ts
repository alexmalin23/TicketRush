import type { RequestHandler } from "express";
import { Logger } from "../logger/logger";
import { REQUEST_ID_HEADER } from "./request-context";

/** Global middleware: logs one line per request when the response finishes. */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
      const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`;
      // "finish" fires from the socket, outside the request's async context: pass the id explicitly.
      // JSON gets the parts as fields so log tooling can filter and aggregate on them.
      const fields =
        logger.format === "json"
          ? [{
              requestId: res.getHeader(REQUEST_ID_HEADER),
              method: req.method,
              path: req.originalUrl,
              status: res.statusCode,
              durationMs: Number(ms.toFixed(1)),
            }]
          : [];

      if (res.statusCode >= 500) logger.error(line, ...fields);
      else if (res.statusCode >= 400) logger.warn(line, ...fields);
      else logger.info(line, ...fields);
    });

    next();
  };
}
