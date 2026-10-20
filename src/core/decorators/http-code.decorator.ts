import "reflect-metadata";

export const HTTP_CODE = "modex:http-code";

/**
 * @HttpCode(200) overrides the default success status of a route.
 * Defaults: POST -> 201, everything else -> 200, and 204 when the handler returns nothing.
 */
export function HttpCode(statusCode: number) {
  return (target: object, propertyKey: string | symbol): void => {
    Reflect.defineMetadata(HTTP_CODE, statusCode, target.constructor, propertyKey);
  };
}
