import type { Request } from "express";
import request from "supertest";
import { z } from "zod";
import { ConflictException, Controller, currentRequestId, ExpressFactory, Get, Post, Validate } from "../../src/core";

/** Reads the request id deep inside the call chain, after an await, without it being passed in. */
const deepRead = async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return currentRequestId();
};

@Controller("/ctx")
class ContextController {
  @Get("/")
  read() {
    return deepRead().then((requestId) => ({ requestId }));
  }

  @Post("/")
  @Validate({ body: z.object({ name: z.string() }) })
  readAfterBody(req: Request) {
    return deepRead().then((requestId) => ({ requestId, name: req.body.name }));
  }

  @Get("/conflict")
  conflict() {
    throw new ConflictException("Seat taken", { seatIds: [7] }, "SEAT_UNAVAILABLE");
  }
}

describe("request context and error codes", () => {
  let api: ReturnType<typeof request>;
  beforeAll(async () => {
    const app = await ExpressFactory.create({ controllers: [ContextController] }, { logLevel: "silent" });
    api = request(app.init().getExpressApp());
  });

  it("assigns a request id, echoes it in the header and keeps it across awaits", async () => {
    const res = await api.get("/ctx").expect(200);
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });

  it("keeps the request id after the JSON body parser", async () => {
    const res = await api.post("/ctx").send({ name: "a" }).expect(201);
    expect(res.body).toEqual({ requestId: res.headers["x-request-id"], name: "a" });
  });

  it("reuses a valid incoming X-Request-Id and replaces an unsafe one", async () => {
    await api.get("/ctx").set("X-Request-Id", "lb-1234").expect(200, { requestId: "lb-1234" });
    for (const unsafe of ["has spaces <script>", "x".repeat(200)]) {
      const res = await api.get("/ctx").set("X-Request-Id", unsafe).expect(200);
      expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("puts a domain code and the request id in error bodies", async () => {
    const res = await api.get("/ctx/conflict").expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      error: "Conflict",
      code: "SEAT_UNAVAILABLE",
      message: "Seat taken",
      details: { seatIds: [7] },
      requestId: res.headers["x-request-id"],
    });
  });

  it("uses VALIDATION_ERROR for invalid input and a request id even for malformed JSON", async () => {
    const invalid = await api.post("/ctx").send({}).expect(400);
    expect(invalid.body.code).toBe("VALIDATION_ERROR");

    const malformed = await api.post("/ctx").set("Content-Type", "application/json").send("{oops").expect(400);
    expect(malformed.body).toMatchObject({ code: "BAD_REQUEST", requestId: malformed.headers["x-request-id"] });
  });
});
