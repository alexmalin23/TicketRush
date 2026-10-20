/**
 * Basic load test: boots the real app on a random port and hammers two endpoints.
 * Uses the database and Redis in .env (run db:migrate first).
 *
 *   npm run test:load
 *   CONNECTIONS=100 DURATION=20 npm run test:load
 */
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import autocannon from "autocannon";
import { appDefinition } from "../src/app";
import { loadDotEnvFile } from "../src/config/env";
import { ExpressFactory } from "../src/core";

const connections = Number(process.env.CONNECTIONS ?? 50);
const duration = Number(process.env.DURATION ?? 10);

async function run(url: string, title: string) {
  const result = await autocannon({ url, connections, duration, title });
  const errors = result.errors + result.timeouts + result.non2xx;
  console.log(
    `${title.padEnd(22)} ${Math.round(result.requests.average).toString().padStart(6)} req/s | ` +
      `latency p50 ${result.latency.p50}ms, p99 ${result.latency.p99}ms | errors/non-2xx: ${errors}`
  );
  return errors;
}

async function main() {
  loadDotEnvFile();
  // "error" level: a log line per request would measure the console, not the app.
  const app = await ExpressFactory.create(appDefinition, { logLevel: "error" });
  const server = await app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  console.log(`Load test: ${connections} connections x ${duration}s per endpoint\n`);
  const errors =
    (await run(`${base}/health`, "GET /health")) +
    (await run(`${base}/ready`, "GET /ready"));

  await app.close();
  if (errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
