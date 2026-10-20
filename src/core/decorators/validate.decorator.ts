import "reflect-metadata";
import type { ZodType } from "zod";

export const VALIDATE = "modex:validate";

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * @Validate({ body: CreateProductSchema, params: IdParamsSchema })
 *
 * Before the handler runs, each part of the request is checked with its Zod schema.
 * - Invalid input: 400 with a list of issues, the handler never runs.
 * - Valid input: req.body / req.params / req.query are REPLACED with the parsed
 *   values, so "5" in the URL arrives as the number 5, strings are trimmed, defaults applied.
 */
export function Validate(schemas: ValidationSchemas) {
  return (target: object, propertyKey: string | symbol): void => {
    Reflect.defineMetadata(VALIDATE, schemas, target.constructor, propertyKey);
  };
}
