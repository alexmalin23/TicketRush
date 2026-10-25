import "reflect-metadata";
import { loadDotEnvFile } from "../config/env";
import { ExpressFactory } from "../core";
import { paymentsProviderApp } from "./app";
import { PROVIDER_CONFIG, ProviderConfig } from "./config";

async function bootstrap() {
  loadDotEnvFile();
  const app = await ExpressFactory.create(paymentsProviderApp);
  const config = app.get<ProviderConfig>(PROVIDER_CONFIG);
  app.enableShutdownHooks();
  await app.listen(config.PAYMENTS_PROVIDER_PORT);
  app.logger.info(`Mock payment provider running on http://localhost:${config.PAYMENTS_PROVIDER_PORT}`);
}

bootstrap().catch((error) => {
  console.error("Failed to start the payment provider:\n", error);
  process.exit(1);
});
