import request from "supertest";
import { Controller, ExpressFactory, Get, Injectable, Logger } from "../../src/core";

@Injectable()
class WorkService {
  private readonly logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger.child("Work");
  }

  async run() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.logger.info("work done", { seats: 2 }); // no request id passed in
    return { ok: true };
  }
}

@Controller("/work")
class WorkController {
  constructor(private readonly work: WorkService) {}

  @Get("/")
  run() {
    return this.work.run();
  }
}

describe("Logger", () => {
  afterEach(() => jest.restoreAllMocks());

  it("json: one object per line, request id added automatically, request line with fields", async () => {
    const lines: string[] = [];
    jest.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));

    const app = await ExpressFactory.create({ controllers: [WorkController] }, { logLevel: "info", logFormat: "json" });
    lines.length = 0; // ignore startup lines
    const res = await request(app.init().getExpressApp()).get("/work").expect(200);
    const requestId = res.headers["x-request-id"];

    const entries = lines.map((line) => JSON.parse(line));
    expect(entries).toContainEqual(
      expect.objectContaining({ level: "info", context: "Work", requestId, msg: "work done", seats: 2 })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ context: "HTTP", requestId, method: "GET", path: "/work", status: 200 })
    );
  });

  it("json: errors become {name, message, stack} instead of breaking the line", () => {
    const lines: string[] = [];
    jest.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));

    new Logger("info", "Db", "json").error("query failed", new Error("boom"));
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ level: "error", context: "Db", msg: "query failed", error: { name: "Error", message: "boom" } });
    expect(entry.error.stack).toContain("boom");
    expect(entry).not.toHaveProperty("requestId"); // outside a request
  });

  it("text: stays human readable", () => {
    const lines: string[] = [];
    jest.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    new Logger("info", "Seed").info("10000 seats");
    expect(lines[0]).toMatch(/^\S+Z INFO  \[Seed\] 10000 seats$/);
  });
});
