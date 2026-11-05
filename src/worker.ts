// Must be the very first import in the project: it enables the Metadata system
import "reflect-metadata";
import { appDefinition } from "./app";
import { loadDotEnvFile } from "./config/env";
import { ExpressFactory } from "./core";
import { PaymentWorker } from "./modules/orders/payment-worker";

/** Same wiring and business logic as the API, without listening for HTTP. */
async function bootstrap() {
  loadDotEnvFile();
  const app = await ExpressFactory.create(appDefinition);
  app.enableShutdownHooks(); // docker stop -> finish the jobs in progress
  app.get(PaymentWorker).start();
  app.logger.info("Payment worker running");
}

bootstrap().catch((error) => {
  console.error("Failed to start the worker:\n", error);
  process.exit(1);
});
