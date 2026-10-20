import "reflect-metadata";
import { CanActivate } from "../guards/can-activate";
import { Type } from "../types";
import { ROUTES, RouteDefinition } from "./route.decorator";

export const GUARDS = "modex:guards";

/**
 * @UseGuards(AuthGuard, RolesGuard)
 *
 * Works on a class (applies to every route in the controller) or on a single method.
 * Guards run in order: class guards first, then method guards.
 */
export function UseGuards(...guards: Type<CanActivate>[]) {
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      // Class decorator: `target` is the class itself
      const existing: Type[] = Reflect.getOwnMetadata(GUARDS, target) ?? [];
      Reflect.defineMetadata(GUARDS, [...existing, ...guards], target);
    } else {
      // Method decorator: `target` is the prototype, so store it on the class + method name
      const controllerClass = target.constructor;
      const existing: Type[] =
        Reflect.getOwnMetadata(GUARDS, controllerClass, propertyKey) ?? [];
      Reflect.defineMetadata(GUARDS, [...existing, ...guards], controllerClass, propertyKey);
    }
  };
}

/** Every guard class used anywhere in a controller, so the factory can register them in DI. */
export function collectGuards(controllerClass: Type): Type<CanActivate>[] {
  const routes: RouteDefinition[] = Reflect.getOwnMetadata(ROUTES, controllerClass) ?? [];
  const all = [
    ...(Reflect.getMetadata(GUARDS, controllerClass) ?? []),
    ...routes.flatMap(
      (route) => Reflect.getMetadata(GUARDS, controllerClass, route.handlerName) ?? []
    ),
  ];
  return [...new Set<Type<CanActivate>>(all)];
}
