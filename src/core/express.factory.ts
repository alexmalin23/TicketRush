import "reflect-metadata";
import express from "express";
import { ModexApplication } from "./application";
import { CONTROLLER_PREFIX } from "./decorators/controller.decorator";
import { ROUTES, RouteDefinition } from "./decorators/route.decorator";
import { collectGuards } from "./decorators/use-guards.decorator";
import { Container } from "./di/container";
import { requestContext } from "./http/request-context";
import { requestLogger } from "./http/request-logger";
import { Logger, LogLevel, parseLogLevel } from "./logger/logger";
import { Provider, Type } from "./types";

/**
 * Everything the framework needs to know about an application.
 * There is no module system: services and models are found automatically
 * from the controllers' constructors (they only need @Injectable()).
 */
export interface AppDefinition {
  /** Every controller of the application. */
  controllers: Type[];
  /** Only for things that are NOT @Injectable classes: config values, a pg Pool... */
  providers?: Provider[];
}

/** Identity helper: gives autocomplete and type checking when writing app.ts. */
export function defineApp(definition: AppDefinition): AppDefinition {
  return definition;
}

export interface CreateOptions {
  /** Defaults to process.env.LOG_LEVEL, then "info". */
  logLevel?: LogLevel;
}

/**
 * ExpressFactory.create(appDefinition) does all the work at startup:
 * 1. Creates the Express app with the global middlewares (request logger, JSON parser)
 * 2. Registers the controllers and the explicit providers in the DI container
 * 3. Builds every controller; their services and models are created along the way
 * 4. Runs onInit() hooks (e.g. the database connection check)
 * 5. Returns a ModexApplication; routes are registered on init() / listen()
 */
export class ExpressFactory {

  static async create(
    definition: AppDefinition,
    options: CreateOptions = {}
  ): Promise<ModexApplication> {

    const logger = new Logger(options.logLevel ?? parseLogLevel(process.env.LOG_LEVEL));

    const expressApp = express();
    expressApp.disable("x-powered-by");
    // Request id first: every later middleware, log line and error carries it.
    expressApp.use(requestContext());
    // Logger next, so even requests the JSON parser rejects (bad JSON) are logged.
    expressApp.use(requestLogger(logger.child("HTTP")));
    expressApp.use(express.json({ limit: "1mb" }));
    // The same controller listed twice would register its routes twice.
    const controllers = [...new Set(definition.controllers)];

    const container = new Container();
    // The logger is available everywhere: just add `logger: Logger` to a constructor.
    container.register({ provide: Logger, useValue: logger });
    definition.providers?.forEach((provider) => container.register(provider));

    // Controllers and their guards are built by DI too, so they get injection like services.
    for (const controller of controllers) {
      container.register(controller);
      collectGuards(controller).forEach((guard) => container.register(guard));
    }

    // Build everything now, so a DI problem (missing @Injectable, circular
    // dependency) fails at startup and not on the first request.
    container.resolveAll();

    try {
      await container.init();
    } catch (error) {
      // Startup failed half way: release what was opened (DB pool) before rethrowing.
      await container.close().catch(() => undefined);
      throw error;
    }

    controllers.forEach((controller) => ExpressFactory.logController(logger, controller));
    return new ModexApplication(expressApp, container, controllers, logger);
  }

  /** Startup log: reads the metadata of a controller and prints a summary line. */
  private static logController(logger: Logger, controllerClass: Type): void {
    const prefix = Reflect.getMetadata(CONTROLLER_PREFIX, controllerClass);
    const routes: RouteDefinition[] = Reflect.getOwnMetadata(ROUTES, controllerClass) ?? [];
    logger.debug(`[Factory] ${controllerClass.name} prefix="${prefix}" routes=${routes.length}`);
  }
}
