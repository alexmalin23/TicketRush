/**
 * Throw these from anywhere (controller, service, guard). The global exception
 * handler turns them into a JSON response with the right status code,
 * so controllers never need their own try/catch.
 */
export class HttpException extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Optional extra data for the client, e.g. a list of validation issues */
    readonly details?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestException extends HttpException {
  constructor(message = "Bad request", details?: unknown) {
    super(400, message, details);
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message = "Unauthorized", details?: unknown) {
    super(401, message, details);
  }
}

export class ForbiddenException extends HttpException {
  constructor(message = "Forbidden resource", details?: unknown) {
    super(403, message, details);
  }
}

export class NotFoundException extends HttpException {
  constructor(message = "Not found", details?: unknown) {
    super(404, message, details);
  }
}

export class ConflictException extends HttpException {
  constructor(message = "Conflict", details?: unknown) {
    super(409, message, details);
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(message = "Service unavailable", details?: unknown) {
    super(503, message, details);
  }
}
