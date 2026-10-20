import type { Request, Response } from "express";
import { Type } from "../types";

/** Everything a guard may need to decide whether a request is allowed. */
export interface ExecutionContext {
  req: Request;
  res: Response;
  controllerClass: Type;
  handlerName: string | symbol;
  /** Reads metadata set with SetMetadata(): the method's value wins over the class's. */
  getMetadata<T>(key: string): T | undefined;
}

/**
 * A guard decides if a request may reach the handler.
 * - return true: continue
 * - return false: the framework responds 403
 * - throw an HttpException (e.g. Unauthorized): that response is sent instead
 *
 * Guards are resolved from the DI container, so they can inject services.
 */
export interface CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean>;
}
