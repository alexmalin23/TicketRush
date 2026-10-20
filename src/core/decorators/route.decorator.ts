import "reflect-metadata";

/** The key under which the list of routes is stored on the class */
export const ROUTES = "modex:routes";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** One route: which HTTP method, which path, and which class method handles it */
export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handlerName: string | symbol;
}

/**
 * Builds a decorator for one HTTP method.
 * This way we do not repeat the same code five times (Get, Post, Put, Patch, Delete).
 */
function createRouteDecorator(method: HttpMethod) {
  return (path = "/"): MethodDecorator =>
    (target, propertyKey) => {
      // In a method decorator, `target` is the class prototype,
      // so the class itself is `target.constructor`.
      const controllerClass = target.constructor;

      // Copy the existing list (if any) and add the new route to it.
      const routes: RouteDefinition[] = [
        ...(Reflect.getOwnMetadata(ROUTES, controllerClass) ?? []),
      ];
      routes.push({ method, path, handlerName: propertyKey });

      Reflect.defineMetadata(ROUTES, routes, controllerClass);
    };
}

export const Get = createRouteDecorator("get");
export const Post = createRouteDecorator("post");
export const Put = createRouteDecorator("put");
export const Patch = createRouteDecorator("patch");
export const Delete = createRouteDecorator("delete");
