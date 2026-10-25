import { defineApp } from "../core";
import { ChargesController } from "./charges.controller";
import { providerConfigProvider } from "./config";

/** The mock payment provider: a separate Modex application, run as its own process. */
export const paymentsProviderApp = defineApp({
  controllers: [ChargesController],
  providers: [providerConfigProvider],
});
