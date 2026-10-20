import "reflect-metadata";

export const INJECTABLE = "modex:injectable";

/**
 * Marks a class as managed by the DI container (Services, Models, Guards...).
 *
 * It does two things:
 * 1. Leaves a marker on the class. The container sees it and creates the class
 *    automatically whenever something needs it: no registration list anywhere.
 * 2. Because the class now has a decorator, TypeScript emits "design:paramtypes"
 *    for it (requires `emitDecoratorMetadata`). That metadata is the list of the
 *    constructor parameter types, and it is what the container reads to know
 *    what to inject. Without any decorator, TypeScript emits nothing.
 */
export function Injectable(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(INJECTABLE, true, target);
  };
}
