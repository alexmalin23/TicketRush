import { Container, Inject, Injectable } from "../../src/core";

@Injectable()
class Engine {
  readonly id = Math.random();
}

@Injectable()
class Car {
  constructor(readonly engine: Engine) {}
}

describe("Container", () => {
  it("creates each provider once (singleton) and injects dependencies by type", () => {
    const container = new Container();
    container.register(Engine);
    container.register(Car);

    const car = container.resolve(Car);
    expect(container.resolve(Car)).toBe(car);
    expect(car.engine).toBe(container.resolve(Engine));
  });

  it("injects explicit tokens with @Inject and useValue", () => {
    @Injectable()
    class UsesConfig {
      constructor(@Inject("CONFIG") readonly config: { url: string }) {}
    }
    const container = new Container();
    container.register({ provide: "CONFIG", useValue: { url: "pg://x" } });
    container.register(UsesConfig);

    expect(container.resolve(UsesConfig).config.url).toBe("pg://x");
  });

  it("passes `inject` tokens to useFactory", () => {
    const container = new Container();
    container.register({ provide: "A", useValue: 2 });
    container.register({ provide: "B", useFactory: (a: number) => a * 10, inject: ["A"] });

    expect(container.resolve("B")).toBe(20);
  });

  it("detects circular dependencies and shows the chain", () => {
    const container = new Container();
    container.register({ provide: "A", useFactory: (b: unknown) => b, inject: ["B"] });
    container.register({ provide: "B", useFactory: (c: unknown) => c, inject: ["C"] });
    container.register({ provide: "C", useFactory: (a: unknown) => a, inject: ["A"] });

    expect(() => container.resolve("A")).toThrow("Circular dependency detected: A -> B -> C -> A");
  });

  it("creates @Injectable classes without registering them (auto-registration)", () => {
    const container = new Container();
    const car = container.resolve(Car); // neither Car nor Engine was registered
    expect(car.engine).toBeInstanceOf(Engine);
    expect(container.resolve(Engine)).toBe(car.engine);
  });

  it("explains a dependency that is not @Injectable", () => {
    class Plain {}
    @Injectable()
    class NeedsPlain {
      constructor(readonly plain: Plain) {}
    }
    const container = new Container();
    expect(() => container.resolve(NeedsPlain)).toThrow(
      'Cannot resolve parameter #0 of "NeedsPlain": "Plain" is not available. Add @Injectable() to Plain.'
    );
  });

  it("explains a missing token provider", () => {
    expect(() => new Container().resolve("PG_POOL")).toThrow(
      'No provider for "PG_POOL". Add a provider for it to "providers" in app.ts.'
    );
  });

  it("asks for @Inject when the parameter type is an interface", () => {
    interface Settings {
      debug: boolean;
    }
    @Injectable()
    class NeedsInterface {
      constructor(readonly settings: Settings) {}
    }
    const container = new Container();
    container.register(NeedsInterface);
    expect(() => container.resolve(NeedsInterface)).toThrow("Use @Inject(token)");
  });

  it("explains a class that forgot @Injectable()", () => {
    class Undecorated {
      constructor(readonly engine: Engine) {}
    }
    const container = new Container();
    container.register(Engine);
    container.register(Undecorated);
    expect(() => container.resolve(Undecorated)).toThrow("Did you forget @Injectable()");
  });

  it("rejects two different definitions for the same token", () => {
    const container = new Container();
    container.register({ provide: "X", useValue: 1 });
    expect(() => container.register({ provide: "X", useValue: 2 })).toThrow("already registered");
  });

  it("runs onInit in creation order and onShutdown in reverse order", async () => {
    const calls: string[] = [];

    @Injectable()
    class Db {
      onInit() {
        calls.push("db:init");
      }
      onShutdown() {
        calls.push("db:shutdown");
      }
    }
    @Injectable()
    class Repo {
      constructor(readonly db: Db) {}
      onInit() {
        calls.push("repo:init");
      }
      onShutdown() {
        calls.push("repo:shutdown");
      }
    }

    const container = new Container();
    container.register(Repo);
    container.register(Db);
    container.resolveAll();

    await container.init();
    await container.close();
    expect(calls).toEqual(["db:init", "repo:init", "repo:shutdown", "db:shutdown"]);
  });

  it("keeps shutting down other providers when one fails", async () => {
    let closed = false;
    const container = new Container();
    container.register({ provide: "ok", useValue: { onShutdown: () => void (closed = true) } });
    container.register({
      provide: "broken",
      useValue: {
        onShutdown: () => {
          throw new Error("boom");
        },
      },
    });
    container.resolveAll();

    await expect(container.close()).rejects.toThrow("failed to shut down");
    expect(closed).toBe(true);
  });
});
