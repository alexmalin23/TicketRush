import "reflect-metadata";
import { INJECT_TOKENS } from "../decorators/inject.decorator";
import { INJECTABLE } from "../decorators/injectable.decorator";
import { Provider, Token, Type } from "../types";

/** Metadata key that TypeScript itself writes: the constructor parameter types. */
const PARAM_TYPES = "design:paramtypes";

function tokenName(token: unknown): string {
  return typeof token === "function" ? token.name : String(token);
}

function tokenOf(provider: Provider): Token {
  return typeof provider === "function" ? provider : provider.provide;
}

/** A class marked with @Injectable() can be created without being registered first. */
function isInjectableClass(token: unknown): token is Type {
  return typeof token === "function" && Reflect.hasOwnMetadata(INJECTABLE, token);
}

/** What to tell the developer when a token cannot be found. */
function missingHint(token: unknown): string {
  return typeof token === "function"
    ? `Add @Injectable() to ${token.name}.`
    : `Add a provider for it to "providers" in app.ts.`;
}

/** True if `instance` has a method called `hook` (used for onInit / onShutdown). */
function hasHook<K extends "onInit" | "onShutdown">(
  instance: unknown,
  hook: K
): instance is Record<K, () => unknown> {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as Record<string, unknown>)[hook] === "function"
  );
}

/**
 * A minimal DI container.
 * - @Injectable() classes are registered automatically the first time something needs them,
 *   so services and models never have to be listed anywhere.
 * - Every provider is a singleton: created once, on first resolve.
 * - Dependencies are read from constructor parameter types, or from @Inject(token).
 * - Circular dependencies are detected and reported with the full chain.
 * - Lifecycle: init() calls onInit() in creation order, close() calls onShutdown() in reverse.
 */
export class Container {
  /** token -> how to build it */
  private readonly providers = new Map<Token, Provider>();
  /** token -> the instance, once built. Insertion order = creation order (dependencies first). */
  private readonly instances = new Map<Token, unknown>();
  /** tokens currently being built, in order; used to detect cycles */
  private readonly resolving: Token[] = [];

  register(provider: Provider): void {
    const token = tokenOf(provider);
    const existing = this.providers.get(token);

    // The same class registered twice is harmless.
    if (existing === provider) return;
    if (existing) {
      throw new Error(
        `A provider for "${tokenName(token)}" is already registered with a different definition`
      );
    }
    this.providers.set(token, provider);
  }

  /** True if the token is registered, or is an @Injectable class that can be registered on demand. */
  has(token: Token): boolean {
    return this.providers.has(token) || isInjectableClass(token);
  }

  /** Returns the singleton instance for a token, building it (and its dependencies) if needed. */
  resolve<T>(token: Token<T>): T {
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    // Auto-registration: an @Injectable class does not need to be listed anywhere.
    if (!this.providers.has(token) && isInjectableClass(token)) {
      this.providers.set(token, token);
    }

    const provider = this.providers.get(token);
    if (!provider) {
      throw new Error(`No provider for "${tokenName(token)}". ${missingHint(token)}`);
    }

    // If this token is already being built further up the call stack, we have a cycle.
    if (this.resolving.includes(token)) {
      const chain = [...this.resolving.slice(this.resolving.indexOf(token)), token]
        .map(tokenName)
        .join(" -> ");
      throw new Error(`Circular dependency detected: ${chain}`);
    }

    this.resolving.push(token);
    try {
      const instance = this.create(provider);
      this.instances.set(token, instance);
      return instance as T;
    } finally {
      this.resolving.pop();
    }
  }

  /**
   * Builds every registered provider (and, through them, everything they depend on).
   * Used at startup so DI errors show up immediately, not on the first request.
   */
  resolveAll(): void {
    for (const token of [...this.providers.keys()]) {
      this.resolve(token);
    }
  }

  /** Runs onInit() hooks, dependencies first (e.g. the DB check runs before anything that uses it). */
  async init(): Promise<void> {
    for (const instance of this.instances.values()) {
      if (hasHook(instance, "onInit")) await instance.onInit();
    }
  }

  /**
   * Runs onShutdown() hooks in reverse creation order: things that USE the database
   * shut down before the database pool itself. One failing hook does not stop the others.
   */
  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const instance of [...this.instances.values()].reverse()) {
      if (!hasHook(instance, "onShutdown")) continue;
      try {
        await instance.onShutdown();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more providers failed to shut down");
    }
  }

  private create(provider: Provider): unknown {
    if (typeof provider === "function") {
      return this.createClass(provider);
    }
    if ("useValue" in provider) {
      return provider.useValue;
    }
    const deps = (provider.inject ?? []).map((dep, index) =>
      this.resolveParam(provider.provide, dep, index)
    );
    return provider.useFactory(...deps);
  }

  private createClass(cls: Type): unknown {
    const paramTypes: unknown[] = Reflect.getMetadata(PARAM_TYPES, cls) ?? [];
    const explicitTokens: Record<number, Token> =
      Reflect.getMetadata(INJECT_TOKENS, cls) ?? {};

    // The constructor takes parameters, but TypeScript emitted no types for it:
    // the class has no decorator at all.
    if (cls.length > 0 && paramTypes.length === 0) {
      throw new Error(
        `${cls.name} has constructor parameters but no type metadata. ` +
          `Did you forget @Injectable() (or @Controller())?`
      );
    }

    const args = paramTypes.map((type, index) =>
      this.resolveParam(cls, explicitTokens[index] ?? type, index)
    );
    return new cls(...args);
  }

  /** Resolves one dependency, with a clear error that says which parameter failed. */
  private resolveParam(owner: Token, token: unknown, index: number): unknown {
    // `Object` is what TypeScript emits for interfaces, unions and `any`.
    // `undefined` usually means a circular import between two files.
    if (token === undefined || token === Object) {
      throw new Error(
        `Cannot resolve parameter #${index} of "${tokenName(owner)}": its type is unknown at runtime ` +
          `(interface, union, "any", or a circular file import). Use @Inject(token) for it.`
      );
    }
    if (!this.has(token as Token)) {
      throw new Error(
        `Cannot resolve parameter #${index} of "${tokenName(owner)}": ` +
          `"${tokenName(token)}" is not available. ${missingHint(token)}`
      );
    }
    return this.resolve(token as Token);
  }
}
