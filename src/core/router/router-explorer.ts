import "reflect-metadata";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { CONTROLLER_PREFIX } from "../decorators/controller.decorator";
import { HTTP_CODE } from "../decorators/http-code.decorator";
import { ROUTES, RouteDefinition } from "../decorators/route.decorator";
import { GUARDS } from "../decorators/use-guards.decorator";
import { VALIDATE, ValidationSchemas } from "../decorators/validate.decorator";
import { Container } from "../di/container";
import { BadRequestException, ForbiddenException } from "../exceptions/http-exceptions";
import { CanActivate, ExecutionContext } from "../guards/can-activate";
import { Logger } from "../logger/logger";
import { Type } from "../types";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

/** Joins paths safely: ("/products", "/:id") => "/products/:id" */
export function joinPaths(...parts: string[]): string {
  const clean = parts
    .join("/")
    .split("/")
    .filter((segment) => segment.length > 0);
  return "/" + clean.join("/");
}

/**
 * True when every URL that `later` matches is already matched by `earlier`,
 * which means Express will never reach `later` (routes are matched in registration order).
 *   shadows("/products/:id", "/products/search") === true   (search is unreachable)
 *   shadows("/products/search", "/products/:id") === false  (correct order)
 */
export function shadows(earlier: string, later: string): boolean {
  const a = earlier.split("/").filter(Boolean);
  const b = later.split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((segment, i) => segment.startsWith(":") || segment === b[i]);
}

/**
 * The RouterExplorer is the heart of the project.
 * It reads the metadata that the decorators left on a controller class and registers
 * every route in Express, wrapped in the request pipeline:
 *
 *   guards -> validation -> handler -> response (JSON / status code)
 *
 * Any error thrown along the way goes to the global exception handler.
 */
export class RouterExplorer {
  /** Routes registered so far, used to detect duplicates and shadowed routes. */
  private readonly registered: { method: string; path: string }[] = [];

  constructor(
    private readonly container: Container,
    private readonly logger: Logger
  ) {}

  /** Registers all routes of one controller. Returns labels like "GET /products/:id". */
  register(app: Express, controllerClass: Type): string[] {
    // 1. Read the base path stored by @Controller
    const prefix: string | undefined = Reflect.getMetadata(CONTROLLER_PREFIX, controllerClass);
    if (prefix === undefined) {
      throw new Error(
        `${controllerClass.name} is not decorated with @Controller(), cannot register it`
      );
    }

    // 2. The controller instance comes from DI, with its services already injected
    const controller = this.container.resolve<Record<string | symbol, unknown>>(controllerClass);

    // 3. Read the list of routes stored by @Get / @Post ...
    const routes: RouteDefinition[] = Reflect.getOwnMetadata(ROUTES, controllerClass) ?? [];
    const mapped: string[] = [];

    for (const route of routes) {
      const fullPath = joinPaths(prefix, route.path);
      const label = `${route.method.toUpperCase()} ${fullPath}`;

      this.assertReachable(route.method, fullPath);
      this.registered.push({ method: route.method, path: fullPath });

      const handler = controller[route.handlerName];
      if (typeof handler !== "function") {
        throw new Error(`${controllerClass.name}.${String(route.handlerName)} is not a method`);
      }

      // 4. Register in Express
      app[route.method](
        fullPath,
        this.createRequestHandler(controllerClass, controller, route, handler as Handler)
      );

      mapped.push(label);
      this.logger.info(`Mapped ${label}`);
    }

    return mapped;
  }

  /** Fails at startup on a duplicate route, or a route that an earlier one makes unreachable. */
  private assertReachable(method: string, path: string): void {
    const blocker = this.registered.find((r) => r.method === method && shadows(r.path, path));
    if (!blocker) return;

    const label = `${method.toUpperCase()} ${path}`;
    if (blocker.path === path) {
      throw new Error(`Duplicate route: ${label}`);
    }
    throw new Error(
      `Route ${label} is unreachable: it is shadowed by ${method.toUpperCase()} ${blocker.path}, ` +
        `which was registered first. Declare the more specific route before it.`
    );
  }

  /** Builds the Express handler for one route. All metadata is read once, here, at startup. */
  private createRequestHandler(
    controllerClass: Type,
    controller: object,
    route: RouteDefinition,
    handler: Handler
  ): RequestHandler {
    const key = route.handlerName;
    const guards = this.resolveGuards(controllerClass, key);
    const schemas: ValidationSchemas | undefined = Reflect.getMetadata(
      VALIDATE,
      controllerClass,
      key
    );
    const statusCode: number =
      Reflect.getMetadata(HTTP_CODE, controllerClass, key) ??
      (route.method === "post" ? 201 : 200);
    const bound = handler.bind(controller);

    // This runs on every request. Express 5 forwards any thrown/rejected error
    // to the exception handler, so no try/catch is needed here.
    return async (req, res, next) => {
      // 1. Guards: authentication / authorization
      const context = createContext(req, res, controllerClass, key);
      for (const guard of guards) {
        if (!(await guard.canActivate(context))) {
          throw new ForbiddenException();
        }
      }

      // 2. Validation: replaces req.body / params / query with parsed values
      if (schemas) validateRequest(req, schemas);

      // 3. The controller method itself
      const result = await bound(req, res, next);

      // 4. Response: skip if the handler already used `res` directly
      if (res.headersSent) return;
      if (result === undefined) {
        res.status(statusCode === 200 ? 204 : statusCode).end();
        return;
      }
      res.status(statusCode).json(result);
    };
  }

  /** Class guards first, then method guards. Instances come from DI (registered by the factory). */
  private resolveGuards(controllerClass: Type, key: string | symbol): CanActivate[] {
    const classGuards: Type<CanActivate>[] = Reflect.getMetadata(GUARDS, controllerClass) ?? [];
    const methodGuards: Type<CanActivate>[] =
      Reflect.getMetadata(GUARDS, controllerClass, key) ?? [];
    return [...classGuards, ...methodGuards].map((guard) => this.container.resolve(guard));
  }
}

function createContext(
  req: Request,
  res: Response,
  controllerClass: Type,
  handlerName: string | symbol
): ExecutionContext {
  return {
    req,
    res,
    controllerClass,
    handlerName,
    getMetadata: <T>(key: string) =>
      (Reflect.getMetadata(key, controllerClass, handlerName) ??
        Reflect.getMetadata(key, controllerClass)) as T | undefined,
  };
}

/** Validates every configured part of the request and collects ALL issues into one 400. */
function validateRequest(req: Request, schemas: ValidationSchemas): void {
  const issues: { path: string; message: string }[] = [];
  const parsed: Partial<Record<keyof ValidationSchemas, unknown>> = {};

  for (const part of ["params", "query", "body"] as const) {
    const schema = schemas[part];
    if (!schema) continue;

    // A request without a JSON body has req.body === undefined; validate it as {}
    // so the client gets "name: required" instead of "expected object".
    const result = schema.safeParse(req[part] ?? {});
    if (result.success) {
      parsed[part] = result.data;
    } else {
      for (const issue of result.error.issues) {
        issues.push({
          path: [part, ...issue.path.map(String)].join("."),
          message: issue.message,
        });
      }
    }
  }

  if (issues.length > 0) {
    throw new BadRequestException("Validation failed", issues, "VALIDATION_ERROR");
  }

  if ("body" in parsed) req.body = parsed.body;
  if ("params" in parsed) req.params = parsed.params as Request["params"];
  // In Express 5 `req.query` is a read-only getter, so we shadow it on this request object.
  if ("query" in parsed) {
    Object.defineProperty(req, "query", {
      value: parsed.query,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}
