// Must be the very first import in the project: it enables the Metadata system
import "reflect-metadata";
import cors from "cors";
import { appDefinition } from "./app";
import { ENV, Env, loadDotEnvFile } from "./config/env";
import { ExpressFactory } from "./core";
import { MetricsService } from "./modules/metrics/metrics.service";

async function bootstrap() {
  loadDotEnvFile(); // .env -> process.env (before anything reads it)

  const app = await ExpressFactory.create(appDefinition);
  const env = app.get<Env>(ENV);

  // Global middlewares go here, before listen() registers the routes.
  app.use(
    cors({ origin: env.CORS_ORIGIN === "*" ? "*" : env.CORS_ORIGIN.split(",").map((o) => o.trim()) })
  );

  app.use(app.get(MetricsService).middleware);

  app.enableShutdownHooks(); // Ctrl+C / docker stop -> finish requests, close the DB pool
  await app.listen(env.PORT);
  app.logger.info(`Server running on http://localhost:${env.PORT}`);
}

bootstrap().catch((error) => {
  console.error("Failed to start the application:\n", error);
  process.exit(1);
});
