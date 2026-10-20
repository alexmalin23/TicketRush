import http from "node:http";
import type { Express, RequestHandler } from "express";
import { Container } from "./di/container";
import { exceptionHandler, notFoundHandler } from "./http/exception-handler";
import { Logger } from "./logger/logger";
import { RouterExplorer } from "./router/router-explorer";
import { Token, Type } from "./types";

/**
 * What ExpressFactory.create() returns: a thin wrapper around the Express app
 * that also owns the DI container and the HTTP server lifecycle.
 *
 * Order of the Express stack after init():
 *   request logger -> json parser -> app.use(...) middlewares -> routes -> 404 -> exception handler
 */
export class ModexApplication {
  private server?: http.Server;
  private initialized = false;
  private closing?: Promise<void>;

  constructor(
    private readonly expressApp: Express,
    private readonly container: Container,
    private readonly controllers: Type[],
    readonly logger: Logger
  ) {}

  /** Adds a global middleware (cors, helmet...). Must be called before init()/listen(). */
  use(...handlers: RequestHandler[]): this {
    if (this.initialized) {
      throw new Error("app.use() must be called before init() / listen()");
    }
    this.expressApp.use(...handlers);
    return this;
  }

  /** Gets any provider from the container, e.g. app.get<Env>(ENV) or app.get(DatabaseService). */
  get<T>(token: Token<T>): T {
    return this.container.resolve(token);
  }

  /** The raw Express app. Call init() first if you need the routes (e.g. for supertest). */
  getExpressApp(): Express {
    return this.expressApp;
  }

  /** Registers the routes, then the 404 and exception handlers. Safe to call twice. */
  init(): this {
    if (this.initialized) return this;

    const explorer = new RouterExplorer(this.container, this.logger.child("Router"));
    for (const controller of this.controllers) {
      explorer.register(this.expressApp, controller);
    }

    // These MUST come after the routes: Express runs the stack in order.
    this.expressApp.use(notFoundHandler());
    this.expressApp.use(exceptionHandler(this.logger.child("Exceptions")));

    this.initialized = true;
    return this;
  }

  /** Starts the HTTP server. Pass 0 to get a random free port (useful in tests). */
  listen(port: number, host?: string): Promise<http.Server> {
    this.init();
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.expressApp);
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        this.server = server;
        resolve(server);
      });
    });
  }

  /**
   * Graceful shutdown: stop accepting connections, let in-flight requests finish,
   * then run every provider's onShutdown() (which closes the DB pool).
   * Calling it more than once returns the same promise.
   */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  /** Calls close() on SIGINT / SIGTERM, and forces an exit if it takes too long. */
  enableShutdownHooks(
    signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"],
    timeoutMs = 10_000
  ): this {
    for (const signal of signals) {
      process.once(signal, () => {
        this.logger.info(`Received ${signal}, shutting down gracefully`);

        const timer = setTimeout(() => {
          this.logger.error(`Shutdown took longer than ${timeoutMs}ms, forcing exit`);
          process.exit(1);
        }, timeoutMs);
        timer.unref();

        this.close().then(
          () => {
            this.logger.info("Shutdown complete");
            process.exit(0);
          },
          (error) => {
            this.logger.error("Shutdown failed", error);
            process.exit(1);
          }
        );
      });
    }
    return this;
  }

  private async shutdown(): Promise<void> {
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    await this.container.close();
  }
}
