import "reflect-metadata";

/**
 * Attaches any custom key/value to a controller class or method.
 * Guards read it back with context.getMetadata(key).
 * Example: Roles("admin") is just SetMetadata("app:roles", ["admin"]).
 */
export function SetMetadata<T>(key: string, value: T) {
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      Reflect.defineMetadata(key, value, target);
    } else {
      Reflect.defineMetadata(key, value, target.constructor, propertyKey);
    }
  };
}
