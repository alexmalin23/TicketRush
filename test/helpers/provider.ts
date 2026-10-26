import type { AddressInfo } from "node:net";
import { ExpressFactory, ModexApplication } from "../../src/core";
import { paymentsProviderApp } from "../../src/payments-provider/app";

export const PROVIDER_DEFAULTS = {
  MOCK_PAYMENT_LATENCY_MS_MIN: "0",
  MOCK_PAYMENT_LATENCY_MS_MAX: "0",
  MOCK_PAYMENT_FAILURE_RATE: "0",
  MOCK_PAYMENT_TIMEOUT_RATE: "0",
  MOCK_PAYMENT_HANG_MS: "300",
};

/** A real provider process-in-a-test: real HTTP on a random port, configured through env like in production. */
export async function startProvider(overrides: Partial<Record<keyof typeof PROVIDER_DEFAULTS, string>> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, PROVIDER_DEFAULTS, overrides);
  try {
    const app: ModexApplication = await ExpressFactory.create(paymentsProviderApp, { logLevel: "silent" });
    const server = await app.listen(0, "127.0.0.1");
    return { app, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  } finally {
    process.env = saved;
  }
}
