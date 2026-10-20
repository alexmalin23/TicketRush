import type { Request, Response } from "express";
import request from "supertest";
import { z } from "zod";
import {
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  ExpressFactory,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Post,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  Validate,
} from "../../src/core";
import { shadows } from "../../src/core/router/router-explorer";

// ---------- A tiny fake app, no database involved ----------

@Injectable()
class GreetingService {
  greet(name: string) {
    return `hello ${name}`;
  }
}

/** x-pass: yes -> allowed, no -> false (403), missing -> throws 401. Also reads metadata. */
@Injectable()
class HeaderGuard implements CanActivate {
  canActivate({ req, getMetadata }: ExecutionContext): boolean {
    const header = req.headers["x-pass"];
    if (!header) throw new UnauthorizedException("no header");
    if (getMetadata<string>("flag") === "vip") return header === "vip";
    return header === "yes";
  }
}

const ItemSchema = z.object({ name: z.string().trim().min(1), qty: z.number().int().default(1) });

@Controller("/items")
class ItemsController {
  constructor(private readonly greetings: GreetingService) {}

  @Get("/")
  list() {
    return [{ id: 1 }];
  }

  @Get("/greet")
  @Validate({ query: z.object({ name: z.string().default("world") }) })
  greet(req: Request<object, unknown, unknown, { name: string }>) {
    return { message: this.greetings.greet(req.query.name) };
  }

  @Get("/:id")
  @Validate({ params: z.object({ id: z.coerce.number().int().positive() }) })
  findOne(req: Request<{ id: number }>) {
    return { id: req.params.id, type: typeof req.params.id };
  }

  @Post("/")
  @Validate({ body: ItemSchema })
  create(req: Request) {
    return req.body;
  }

  @Post("/accepted")
  @HttpCode(202)
  accept() {
    return { queued: true };
  }

  @Delete("/:id")
  remove() {
    // returns nothing -> 204
  }

  @Get("/raw/res")
  raw(_req: Request, res: Response) {
    res.status(418).json({ teapot: true });
  }

  @Get("/fail/not-found")
  async notFound() {
    throw new NotFoundException("nope");
  }

  @Get("/fail/crash")
  async crash() {
    throw new Error("secret database password in message");
  }
}

@Controller("/secure")
@UseGuards(HeaderGuard)
class SecureController {
  @Get("/")
  open() {
    return { ok: true };
  }

  @Get("/vip")
  @SetMetadata("flag", "vip")
  vip() {
    return { vip: true };
  }
}

// GreetingService is not listed anywhere: it is @Injectable, so DI finds it from the constructor.
async function createApp() {
  const app = await ExpressFactory.create(
    { controllers: [ItemsController, SecureController] },
    { logLevel: "silent" }
  );
  return request(app.init().getExpressApp());
}

// ---------- Tests ----------

describe("Router pipeline", () => {
  let api: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    api = await createApp();
  });

  it("registers routes from decorators and sends return values as JSON", async () => {
    await api.get("/items").expect(200, [{ id: 1 }]);
  });

  it("injects services into controllers", async () => {
    await api.get("/items/greet?name=dan").expect(200, { message: "hello dan" });
  });

  it("applies query defaults", async () => {
    await api.get("/items/greet").expect(200, { message: "hello world" });
  });

  it("coerces validated params ('7' -> 7)", async () => {
    await api.get("/items/7").expect(200, { id: 7, type: "number" });
  });

  it("rejects invalid params with 400 and the issue path", async () => {
    const res = await api.get("/items/abc").expect(400);
    expect(res.body.message).toBe("Validation failed");
    expect(res.body.details[0].path).toBe("params.id");
  });

  it("POST defaults to 201 and the body is replaced with the parsed value", async () => {
    await api.post("/items").send({ name: "  pen  " }).expect(201, { name: "pen", qty: 1 });
  });

  it("reports every body issue at once", async () => {
    const res = await api.post("/items").send({ name: "", qty: 1.5 }).expect(400);
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(["body.name", "body.qty"]);
  });

  it("validates a missing body as an empty object", async () => {
    const res = await api.post("/items").expect(400);
    expect(res.body.details[0].path).toBe("body.name");
  });

  it("@HttpCode overrides the status", async () => {
    await api.post("/items/accepted").expect(202, { queued: true });
  });

  it("returns 204 when the handler returns nothing", async () => {
    await api.delete("/items/1").expect(204, "");
  });

  it("does not send twice when the handler uses res directly", async () => {
    await api.get("/items/raw/res").expect(418, { teapot: true });
  });

  it("turns HttpExceptions into JSON errors", async () => {
    await api
      .get("/items/fail/not-found")
      .expect(404, { statusCode: 404, error: "Not Found", message: "nope" });
  });

  it("hides internal error messages behind a generic 500", async () => {
    const res = await api.get("/items/fail/crash").expect(500);
    expect(res.body.message).toBe("Internal server error");
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("answers unknown routes with a JSON 404", async () => {
    await api.get("/missing").expect(404, { statusCode: 404, error: "Not Found", message: "Cannot GET /missing" });
  });

  it("answers malformed JSON with 400", async () => {
    const res = await api.post("/items").set("Content-Type", "application/json").send("{bad").expect(400);
    expect(res.body.message).toBe("Malformed JSON body");
  });

  describe("guards", () => {
    it("a guard that throws decides the response (401)", async () => {
      await api.get("/secure").expect(401);
    });

    it("a guard that returns false gives 403", async () => {
      await api.get("/secure").set("x-pass", "no").expect(403);
    });

    it("a guard that returns true lets the request through", async () => {
      await api.get("/secure").set("x-pass", "yes").expect(200, { ok: true });
    });

    it("guards can read route metadata", async () => {
      await api.get("/secure/vip").set("x-pass", "yes").expect(403);
      await api.get("/secure/vip").set("x-pass", "vip").expect(200, { vip: true });
    });
  });
});

describe("Route conflicts", () => {
  it("shadows() detects a param route that hides a literal one", () => {
    expect(shadows("/products/:id", "/products/search")).toBe(true);
    expect(shadows("/products/search", "/products/:id")).toBe(false);
    expect(shadows("/a/:x", "/a/:y")).toBe(true);
    expect(shadows("/a/:x", "/a/b/c")).toBe(false);
  });

  it("fails at startup on a duplicate route", async () => {
    @Controller("/dup")
    class DuplicateController {
      @Get("/")
      a() {
        return 1;
      }
      @Get("/")
      b() {
        return 2;
      }
    }
    const app = await ExpressFactory.create({ controllers: [DuplicateController] }, { logLevel: "silent" });
    expect(() => app.init()).toThrow("Duplicate route: GET /dup");
  });

  it("fails at startup on an unreachable route", async () => {
    @Controller("/p")
    class ShadowController {
      @Get("/:id")
      one() {
        return 1;
      }
      @Get("/search")
      search() {
        return 2;
      }
    }
    const app = await ExpressFactory.create({ controllers: [ShadowController] }, { logLevel: "silent" });
    expect(() => app.init()).toThrow("Route GET /p/search is unreachable");
  });

  it("fails at startup when a controller depends on a class without @Injectable()", async () => {
    class PlainService {}
    @Controller("/plain")
    class PlainController {
      constructor(readonly plain: PlainService) {}
      @Get("/")
      get() {
        return 1;
      }
    }
    await expect(
      ExpressFactory.create({ controllers: [PlainController] }, { logLevel: "silent" })
    ).rejects.toThrow("Add @Injectable() to PlainService");
  });

  it("refuses app.use() after the routes are registered", async () => {
    const app = await ExpressFactory.create({ controllers: [] }, { logLevel: "silent" });
    app.init();
    expect(() => app.use((_req, _res, next) => next())).toThrow("before init()");
  });
});
