import { startProvider } from "./provider";
import { createTestApp } from "./test-app";

export type ProviderOverrides = Parameters<typeof startProvider>[0];

/** The API and a real payment provider, started together; env is set before each starts and restored after. */
export async function startStack(provider: ProviderOverrides, apiEnv: Record<string, string> = {}, providerUrl?: string) {
  const mock = await startProvider(provider);
  const saved = { ...process.env };
  Object.assign(process.env, {
    PAYMENTS_PROVIDER_URL: providerUrl ?? mock.url,
    PAYMENT_TIMEOUT_MS: "2000",
    ENABLE_DEV_ROUTES: "true",
    ...apiEnv,
  });
  try {
    const app = await createTestApp();
    return {
      app,
      mock,
      stop: async () => {
        await app.close();
        await mock.app.close();
      },
    };
  } finally {
    process.env = saved;
  }
}
