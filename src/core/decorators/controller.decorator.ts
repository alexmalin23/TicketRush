import "reflect-metadata";

/**
 * The key under which the base path is stored on the class.
 * Metadata is like a note stuck on the class that anyone can read later.
 */
export const CONTROLLER_PREFIX = "modex:controller:prefix";

/**
 * @Controller("/products")
 *
 * The decorator does NOT register any route itself.
 * It only sticks a note on the class: "my base path is /products".
 * The RouterExplorer reads that note and does the real registration in Express.
 *
 * It also makes TypeScript emit the constructor parameter types for this class,
 * which is how the DI container knows what to inject into the controller.
 */
export function Controller(prefix = ""): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(CONTROLLER_PREFIX, prefix, target);
  };
}
