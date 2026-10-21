/** Default machine-readable code per status; pass an explicit code for domain errors. */
const DEFAULT_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMITED",
  500: "INTERNAL",
  503: "SERVICE_UNAVAILABLE",
};

export function defaultErrorCode(statusCode: number): string {
  return DEFAULT_CODES[statusCode] ?? (statusCode >= 500 ? "INTERNAL" : "ERROR");
}

/**
 * Throw these from anywhere (controller, service, guard). The global exception
 * handler turns them into a JSON response with the right status code,
 * so controllers never need their own try/catch.
 *
 * `code` is what clients branch on (e.g. "SEAT_UNAVAILABLE"); `message` is for humans.
 */
export class HttpException extends Error {
  readonly code: string;

  constructor(
    readonly statusCode: number,
    message: string,
    /** Optional extra data for the client, e.g. a list of validation issues */
    readonly details?: unknown,
    code?: string
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code ?? defaultErrorCode(statusCode);
  }
}

export class BadRequestException extends HttpException {
  constructor(message = "Bad request", details?: unknown, code?: string) {
    super(400, message, details, code);
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message = "Unauthorized", details?: unknown, code?: string) {
    super(401, message, details, code);
  }
}

export class ForbiddenException extends HttpException {
  constructor(message = "Forbidden resource", details?: unknown, code?: string) {
    super(403, message, details, code);
  }
}

export class NotFoundException extends HttpException {
  constructor(message = "Not found", details?: unknown, code?: string) {
    super(404, message, details, code);
  }
}

export class ConflictException extends HttpException {
  constructor(message = "Conflict", details?: unknown, code?: string) {
    super(409, message, details, code);
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(message = "Service unavailable", details?: unknown, code?: string) {
    super(503, message, details, code);
  }
}
