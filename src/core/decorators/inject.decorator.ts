import "reflect-metadata";
import { Token } from "../types";

export const INJECT_TOKENS = "modex:inject-tokens";

/**
 * @Inject("PG_POOL") on a constructor parameter: use this explicit token
 * instead of the parameter's type.
 *
 * Needed when the type cannot identify the dependency:
 * - interfaces and unions are erased at runtime (TypeScript emits `Object`)
 * - values like a pg Pool are not our own @Injectable classes
 */
export function Inject(token: Token): ParameterDecorator {
  return (target, _propertyKey, parameterIndex) => {
    // For constructor parameters, `target` is the class itself.
    // Copy the existing map so a subclass never mutates its parent's metadata.
    const tokens: Record<number, Token> = {
      ...(Reflect.getOwnMetadata(INJECT_TOKENS, target) ?? {}),
    };
    tokens[parameterIndex] = token;
    Reflect.defineMetadata(INJECT_TOKENS, tokens, target);
  };
}
