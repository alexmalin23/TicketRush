/**
 * A class (the constructor), not an instance of it.
 * Type<Foo> means "Foo itself", the thing you can call `new` on.
 */
export type Type<T = any> = new (...args: any[]) => T;

/** What a dependency is looked up by: a class, or an explicit string/symbol token. */
export type Token<T = any> = Type<T> | string | symbol;

/** Provides a ready-made value under a token (config, a library object, a mock...). */
export interface ValueProvider {
  provide: Token;
  useValue: unknown;
}

/**
 * Builds the value with a function.
 * `inject` lists the tokens whose instances are passed to `useFactory` as arguments.
 */
export interface FactoryProvider {
  provide: Token;
  useFactory: (...deps: any[]) => unknown;
  inject?: Token[];
}

/** A provider is a class (its token is the class itself) or one of the object forms above. */
export type Provider = Type | ValueProvider | FactoryProvider;

/** Lifecycle hook: called once after every provider is built, before the server starts. */
export interface OnInit {
  onInit(): void | Promise<void>;
}

/** Lifecycle hook: called once when the application shuts down (close DB pools, flush logs...). */
export interface OnShutdown {
  onShutdown(): void | Promise<void>;
}
