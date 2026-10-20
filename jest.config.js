/** ts-jest compiles with the real TypeScript compiler, so emitDecoratorMetadata works
 *  (Vitest / esbuild would NOT emit it and DI would break). */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.spec.ts"],
  setupFiles: ["<rootDir>/test/setup-env.ts"],
  testTimeout: 20000,
};
